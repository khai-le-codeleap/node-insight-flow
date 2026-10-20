//! project-mcp: MCP server (stdio, newline-delimited JSON-RPC) for exploring a project.
//! Semantic TS/JS tools are served by a Bun sidecar (sidecar/ts.cjs) running TypeScript's LanguageService.
//! `call_flow` pages are served over HTTP on 127.0.0.1 by this same process.
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};

use ignore::WalkBuilder;
use serde_json::{json, Value};

type R = Result<String, String>;

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LINE_CHARS: usize = 200;
const SIDECAR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/sidecar/ts.cjs");
const MERMAID_JS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/sidecar/node_modules/mermaid/dist/mermaid.min.js");
const FLOW_HTML: &str = include_str!("flow.html");

/// The sidecar, shared by the stdio loop and the HTTP thread.
type Ts = Arc<Mutex<Option<Sidecar>>>;
const SEMANTIC: &[&str] = &["go_to_definition", "find_references", "incoming_calls", "type_info", "rename_preview", "diagnostics", "ts_projects", "ts_reload", "call_flow"];

fn main() {
    let root = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap());
    let root = root.canonicalize().unwrap_or_else(|e| panic!("invalid root {}: {e}", root.display()));
    // Started on initialize or the first semantic call, then kept for the session.
    let ts: Ts = Arc::new(Mutex::new(None));
    // HTTP port for call_flow pages, bound on the first call_flow.
    let mut web: Option<u16> = None;
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(&mut out, json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}));
                continue;
            }
        };
        // Notifications (no id) need no reply.
        let Some(id) = msg.get("id").cloned() else { continue };
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => {
                // Start the sidecar now so it builds the TS programs while the client gets going.
                // shortcut: only when the root looks like a JS/TS project; other roots start it on first use.
                let mut guard = lock(&ts);
                if guard.is_none() && ["tsconfig.json", "jsconfig.json", "package.json"].iter().any(|f| root.join(f).exists()) {
                    *guard = Sidecar::spawn(&root).ok();
                }
                json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "project-mcp", "version": env!("CARGO_PKG_VERSION")},
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools": tools()}),
            "tools/call" => call(&root, &ts, &mut web, &msg["params"]),
            m => {
                send(&mut out, json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("method not found: {m}")}}));
                continue;
            }
        };
        send(&mut out, json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
}

fn send(out: &mut impl Write, v: Value) {
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn tools() -> Value {
    let path = json!({"type": "string", "description": "Path relative to project root (default: root)"});
    let max = |d: u64| json!({"type": "integer", "description": format!("Max results (default {d})")});
    let tool = |name: &str, desc: &str, props: Value, required: &[&str]| {
        json!({"name": name, "description": desc, "inputSchema": {"type": "object", "properties": props, "required": required}})
    };
    // Where a semantic tool should look: a symbol name, or an exact file position.
    let target = |extra: Value| {
        let mut p = json!({
            "symbol": {"type": "string", "description": "Symbol name. If several declarations match, a list is returned to pick from"},
            "file": {"type": "string", "description": "Relative file path, to disambiguate `symbol` or with line + column"},
            "line": {"type": "integer", "description": "1-based"},
            "column": {"type": "integer", "description": "1-based"},
        });
        p.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        p
    };
    const TS: &str = " TS/JS only, uses the TypeScript LanguageService (same engine as VSCode): follows renamed imports, barrels, default exports, tsconfig paths and monorepo packages; ignores comments, strings and unrelated same-named symbols.";
    json!([
        tool("project_overview", "Summary of the project: top-level entries, manifests, file counts by extension. Respects .gitignore.", json!({}), &[]),
        tool("list_docs", "List Markdown files with their # and ## headings. On big repos pass `path` to narrow.", json!({"path": path, "max_results": max(50)}), &[]),
        tool("read_doc", "Read a Markdown file, or only the section under a heading (case-insensitive substring match).", json!({"path": {"type": "string"}, "heading": {"type": "string"}}), &["path"]),
        tool("list_logs", "List *.log files (including gitignored ones) with size.", json!({"path": path}), &[]),
        tool("read_log", "Tail of a log file, optionally only lines containing a level/keyword.", json!({"path": {"type": "string"}, "lines": {"type": "integer", "description": "Default 200"}, "level": {"type": "string", "description": "e.g. error, warn"}}), &["path"]),
        tool("summarize_log", "Count lines per level and group error/fatal lines by message (numbers and ids normalized).", json!({"path": {"type": "string"}, "max_results": max(20)}), &["path"]),
        tool("go_to_definition", &format!("Where a symbol is defined (F12).{TS}"), target(json!({})), &[]),
        tool("find_references", &format!("Every place a symbol is used, grouped by file (Shift+F12). Prefer this over grep before refactoring.{TS}"),
            target(json!({"includeDefinition": {"type": "boolean", "description": "Also list declarations and imports (default true)"}})), &[]),
        tool("incoming_calls", &format!("Who calls this function/method, optionally recursive (call hierarchy).{TS}"),
            target(json!({"depth": {"type": "integer", "description": "Levels of callers, 1-5 (default 1)"}})), &[]),
        tool("type_info", &format!("Inferred type and JSDoc of a symbol (hover).{TS}"), target(json!({})), &[]),
        tool("rename_preview", &format!("Every edit a rename would make, shown as -old/+new lines. Writes nothing.{TS}"),
            target(json!({"newName": {"type": "string"}})), &["newName"]),
        tool("diagnostics", "TypeScript errors (syntactic + semantic) for a file or directory, with code and line.",
            json!({"path": path, "maxResults": max(50)}), &[]),
        tool("call_flow", &format!("Control-flow chart (Mermaid) of a function or API handler: statements that call project code, \
chained in source order, with if/switch/loop/try branches and return/throw ends, plus the code of every function called. \
Built from the syntax tree and the type checker: calls resolve to their declarations, interface/injected-service calls to \
their implementation. Unresolvable calls are listed separately. To go deeper, call it again on a called function. \
Entry: the handler's `symbol`, or `file` + `line` anywhere inside an inline handler. The result starts with a link to an interactive page.{TS}"),
            target(json!({
                "maxLines": {"type": "integer", "description": "Code lines shown per called function (default 60)"},
                "includeTests": {"type": "boolean", "description": "Also show calls into test/mock files (default false)"},
            })), &[]),
        tool("ts_projects", "List the tsconfig projects found (monorepo packages), their file counts and the TypeScript version in use.", json!({}), &[]),
        tool("ts_reload", "Rebuild all TypeScript projects from scratch. Only needed if results look stale after changing packages in a way that touched no lockfile, package.json or node_modules entry.", json!({}), &[]),
    ])
}

fn call(root: &Path, ts: &Ts, web: &mut Option<u16>, params: &Value) -> Value {
    let a = &params["arguments"];
    let res = match params["name"].as_str().unwrap_or("") {
        "project_overview" => project_overview(root),
        "list_docs" => list_docs(root, a),
        "read_doc" => read_doc(root, a),
        "list_logs" => list_logs(root, a),
        "read_log" => read_log(root, a),
        "summarize_log" => summarize_log(root, a),
        "call_flow" => semantic(root, &mut lock(ts), "call_flow", a).map(|text| {
            if web.is_none() {
                *web = start_web(root.to_path_buf(), ts.clone()).map_err(|e| eprintln!("project-mcp: HTTP server: {e}")).ok();
            }
            match web {
                Some(port) => format!("open in browser: {}\n\n{text}", flow_url(*port, a)),
                None => text,
            }
        }),
        n if SEMANTIC.contains(&n) => semantic(root, &mut lock(ts), n, a),
        n => Err(format!("unknown tool: {n}")),
    };
    let (text, is_error) = match res {
        Ok(t) => (t, false),
        Err(e) => (e, true),
    };
    json!({"content": [{"type": "text", "text": text}], "isError": is_error})
}

// ---------- semantic (TypeScript sidecar) ----------

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    fn spawn(root: &Path) -> io::Result<Self> {
        let mut child = Command::new("bun")
            .arg(SIDECAR)
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| io::Error::other(format!("cannot start `bun {SIDECAR}`: {e}")))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, stdin, stdout })
    }

    fn request(&mut self, tool: &str, args: &Value) -> io::Result<Value> {
        writeln!(self.stdin, "{}", json!({"id": 1, "tool": tool, "args": args}))?;
        self.stdin.flush()?;
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Err(io::Error::other("TypeScript sidecar exited (see server stderr)"));
        }
        serde_json::from_str(&line).map_err(io::Error::other)
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn semantic(root: &Path, ts: &mut Option<Sidecar>, tool: &str, a: &Value) -> R {
    if ts.is_none() {
        *ts = Some(Sidecar::spawn(root).map_err(|e| e.to_string())?);
    }
    match ts.as_mut().unwrap().request(tool, a) {
        Ok(v) => match v["error"].as_str() {
            Some(e) => Err(e.to_string()),
            None => Ok(v["text"].as_str().unwrap_or_default().to_string()),
        },
        Err(e) => {
            *ts = None; // restart on the next call
            Err(e.to_string())
        }
    }
}

fn lock(ts: &Ts) -> MutexGuard<'_, Option<Sidecar>> {
    ts.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------- call_flow web page ----------

/// call_flow args carried in the page URL, so each load re-runs against the current code.
const FLOW_ARGS: &[&str] = &["symbol", "file", "line", "column", "maxLines", "includeTests"];

fn start_web(root: PathBuf, ts: Ts) -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if let Err(e) = serve(&root, &ts, port, stream) {
                eprintln!("project-mcp: HTTP: {e}");
            }
        }
    });
    Ok(port)
}

fn flow_url(port: u16, a: &Value) -> String {
    let q: Vec<String> = FLOW_ARGS
        .iter()
        .filter_map(|k| {
            let v = a.get(*k)?;
            let v = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
            Some(format!("{k}={}", pct_encode(&v)))
        })
        .collect();
    format!("http://127.0.0.1:{port}/flow?{}", q.join("&"))
}

fn serve(root: &Path, ts: &Ts, port: u16, mut stream: TcpStream) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut host = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("host") {
                host = v.trim().to_string();
            }
        }
    }
    // DNS-rebinding guard: a web page can make the browser hit this port under its own hostname.
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"forbidden host");
    }
    let target = request.split_whitespace().nth(1).unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/mermaid.js" => match std::fs::read(MERMAID_JS) {
            Ok(js) => respond(&mut stream, "200 OK", "text/javascript", &js),
            Err(e) => respond(&mut stream, "500 Internal Server Error", "text/plain", format!("{MERMAID_JS}: {e} (run `bun install` in sidecar/)").as_bytes()),
        },
        "/flow" => {
            let mut a = query_args(query);
            a["format"] = json!("json");
            match semantic(root, &mut lock(ts), "call_flow", &a) {
                // `</` inside the inlined JSON would end the <script> early.
                Ok(data) => respond(&mut stream, "200 OK", "text/html; charset=utf-8", FLOW_HTML.replace("/*DATA*/null", &data.replace("</", "<\\/")).as_bytes()),
                Err(e) => respond(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", e.as_bytes()),
            }
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found"),
    }
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

/// Query string -> call_flow args (numbers and booleans typed, unknown keys dropped).
fn query_args(query: &str) -> Value {
    let mut a = json!({});
    for (k, v) in query.split('&').filter_map(|kv| kv.split_once('=')) {
        if !FLOW_ARGS.contains(&k) {
            continue;
        }
        let v = pct_decode(v);
        a[k] = match k {
            "symbol" | "file" => json!(v),
            "includeTests" => json!(v == "true" || v == "1"),
            _ => v.parse::<u64>().map_or(Value::Null, |n| json!(n)),
        };
    }
    a
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit));
        match (b[i], hex) {
            (b'%', Some(h)) => {
                out.push(u8::from_str_radix(std::str::from_utf8(h).unwrap(), 16).unwrap());
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- helpers ----------

fn arg_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn arg_usize(a: &Value, k: &str, default: usize) -> usize {
    a.get(k).and_then(Value::as_u64).map_or(default, |n| n as usize)
}

/// Resolve a user path inside root; rejects anything escaping it (trust boundary).
fn resolve(root: &Path, rel: Option<&str>) -> Result<PathBuf, String> {
    let p = root.join(rel.unwrap_or(".")).canonicalize().map_err(|e| format!("{}: {e}", rel.unwrap_or(".")))?;
    if !p.starts_with(root) {
        return Err(format!("path outside project root: {}", rel.unwrap_or("")));
    }
    Ok(p)
}

fn rel(root: &Path, p: &Path) -> String {
    let r = p.strip_prefix(root).unwrap_or(p).to_string_lossy().into_owned();
    if r.is_empty() { ".".into() } else { r }
}

fn clip(s: &str) -> String {
    let s = s.trim_end();
    match s.char_indices().nth(MAX_LINE_CHARS) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// Files under `base`, respecting .gitignore, sorted by path.
fn files(base: &Path) -> impl Iterator<Item = PathBuf> {
    WalkBuilder::new(base)
        .sort_by_file_name(|a, b| a.cmp(b))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .map(|e| e.into_path())
}

// ---------- structure ----------

fn project_overview(root: &Path) -> R {
    let mut out = format!("root: {}\n\ntop-level:\n", root.display());
    for e in WalkBuilder::new(root).max_depth(Some(1)).sort_by_file_name(|a, b| a.cmp(b)).build().filter_map(Result::ok).skip(1) {
        let dir = if e.file_type().is_some_and(|t| t.is_dir()) { "/" } else { "" };
        out += &format!("  {}{dir}\n", e.file_name().to_string_lossy());
    }

    let manifests = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "Gemfile", "composer.json", "Makefile", "Dockerfile"];
    let found: Vec<_> = manifests.iter().filter(|m| root.join(m).exists()).copied().collect();
    if !found.is_empty() {
        out += &format!("\nmanifests: {}\n", found.join(", "));
    }
    if let Ok(pkg) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<Value>(&pkg) {
            if let Some(name) = pkg["name"].as_str() {
                out += &format!("package: {name}\n");
            }
            if let Some(s) = pkg["scripts"].as_object() {
                out += &format!("scripts: {}\n", s.keys().cloned().collect::<Vec<_>>().join(", "));
            }
        }
    }

    let mut by_ext: HashMap<String, usize> = HashMap::new();
    let mut total = 0;
    for f in files(root) {
        total += 1;
        let ext = f.extension().map_or("(none)".into(), |e| e.to_string_lossy().into_owned());
        *by_ext.entry(ext).or_default() += 1;
    }
    let mut by_ext: Vec<_> = by_ext.into_iter().collect();
    by_ext.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out += &format!("\nfiles: {total}\n");
    for (ext, n) in by_ext.iter().take(15) {
        out += &format!("  .{ext}: {n}\n");
    }
    Ok(out)
}

// ---------- docs ----------

fn is_md(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("mdx"))
}

/// (line index, level, title) of each ATX heading, skipping fenced code blocks.
fn headings(text: &str) -> Vec<(usize, usize, &str)> {
    let mut fence = false;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        } else if !fence && t.starts_with('#') {
            let level = t.chars().take_while(|&c| c == '#').count();
            if level <= 6 && t[level..].starts_with(' ') {
                out.push((i, level, t[level..].trim()));
            }
        }
    }
    out
}

fn section<'a>(text: &'a str, heading: &str) -> Option<String> {
    let hs = headings(text);
    let needle = heading.to_lowercase();
    let idx = hs.iter().position(|h| h.2.to_lowercase().contains(&needle))?;
    let (start, level, _) = hs[idx];
    let end = hs[idx + 1..].iter().find(|h| h.1 <= level).map_or(usize::MAX, |h| h.0);
    Some(text.lines().skip(start).take(end - start).collect::<Vec<_>>().join("\n"))
}

fn list_docs(root: &Path, a: &Value) -> R {
    let base = resolve(root, arg_str(a, "path"))?;
    let max = arg_usize(a, "max_results", 50);
    let docs: Vec<_> = files(&base).filter(|f| is_md(f)).collect();
    let mut out = String::new();
    if docs.len() > max {
        out += &format!("showing {max} of {} markdown files, pass `path` to narrow\n\n", docs.len());
    }
    for f in docs.into_iter().take(max) {
        out += &format!("{}\n", rel(root, &f));
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        for (_, level, title) in headings(&text).into_iter().filter(|h| h.1 <= 2) {
            out += &format!("  {}{title}\n", "  ".repeat(level - 1));
        }
    }
    Ok(if out.is_empty() { "no markdown files".into() } else { out })
}

fn read_doc(root: &Path, a: &Value) -> R {
    let p = resolve(root, arg_str(a, "path"))?;
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    match arg_str(a, "heading") {
        None => Ok(text),
        Some(h) => section(&text, h).ok_or_else(|| {
            let all: Vec<_> = headings(&text).into_iter().map(|h| h.2).collect();
            format!("heading not found: {h}\navailable: {}", all.join(" | "))
        }),
    }
}

// ---------- logs ----------

fn is_log(p: &Path) -> bool {
    let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    n.ends_with(".log") || n.contains(".log.")
}

fn list_logs(root: &Path, a: &Value) -> R {
    let base = resolve(root, arg_str(a, "path"))?;
    // Logs are usually gitignored, so ignore rules are off here; skip the usual heavy dirs instead.
    let walker = WalkBuilder::new(&base)
        .git_ignore(false)
        .ignore(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some("node_modules" | ".git" | "target" | "dist" | "build")))
        .build();
    let mut out = String::new();
    for e in walker.filter_map(Result::ok).filter(|e| e.file_type().is_some_and(|t| t.is_file()) && is_log(e.path())) {
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        out += &format!("{}  ({} KB)\n", rel(root, e.path()), size.div_ceil(1024));
    }
    Ok(if out.is_empty() { "no log files".into() } else { out })
}

/// Last MAX_LOG_BYTES of a file as text (first partial line dropped when truncated).
fn read_tail(p: &Path) -> Result<String, String> {
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(MAX_LOG_BYTES);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(if start > 0 { text.split_once('\n').map_or(text.clone(), |(_, rest)| rest.to_string()) } else { text })
}

fn read_log(root: &Path, a: &Value) -> R {
    let text = read_tail(&resolve(root, arg_str(a, "path"))?)?;
    let n = arg_usize(a, "lines", 200);
    let level = arg_str(a, "level").map(str::to_lowercase);
    let lines: Vec<_> = text.lines().filter(|l| level.as_ref().is_none_or(|lv| l.to_lowercase().contains(lv))).collect();
    Ok(lines[lines.len().saturating_sub(n)..].iter().map(|l| clip(l)).collect::<Vec<_>>().join("\n"))
}

/// Replace volatile parts (hex ids, numbers) so repeated errors group together.
fn normalize(line: &str) -> String {
    use std::sync::LazyLock;
    static HEX: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\b(?:0x)?[0-9a-fA-F]{8,}\b").unwrap());
    static NUM: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\d+").unwrap());
    NUM.replace_all(&HEX.replace_all(line, "<id>"), "N").into_owned()
}

fn summarize_log(root: &Path, a: &Value) -> R {
    use std::sync::LazyLock;
    static LEVEL: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)\b(fatal|error|warn(?:ing)?|info|debug|trace)\b").unwrap());
    let text = read_tail(&resolve(root, arg_str(a, "path"))?)?;
    let max = arg_usize(a, "max_results", 20);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    // normalized message -> (count, last example)
    let mut groups: HashMap<String, (usize, &str)> = HashMap::new();
    let mut total = 0;
    for line in text.lines() {
        total += 1;
        let Some(m) = LEVEL.find(line) else { continue };
        let lv = m.as_str().to_lowercase().replace("warning", "warn");
        if lv == "error" || lv == "fatal" {
            let g = groups.entry(normalize(line)).or_insert((0, line));
            g.0 += 1;
            g.1 = line;
        }
        *counts.entry(lv).or_default() += 1;
    }
    let mut out = format!("lines: {total}\n");
    for (lv, n) in &counts {
        out += &format!("  {lv}: {n}\n");
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| b.0.cmp(&a.0));
    if !groups.is_empty() {
        out += &format!("\ntop error groups ({} distinct):\n", groups.len());
        for (n, ex) in groups.iter().take(max) {
            out += &format!("  {n}×  {}\n", clip(ex));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_stops_at_same_level_and_ignores_fences() {
        let md = "# A\n## B\nb text\n```\n# not heading\n```\n### B1\n## C\nc";
        assert_eq!(section(md, "b").unwrap(), "## B\nb text\n```\n# not heading\n```\n### B1");
        assert_eq!(headings(md).len(), 4);
    }

    #[test]
    fn normalize_groups_numbers_and_ids() {
        assert_eq!(normalize("12:01 user 42 failed deadbeef01"), normalize("13:55 user 7 failed cafebabe99"));
    }

    #[test]
    fn ts_references_are_semantic_and_fresh() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
        let root = std::env::temp_dir().join(format!("project-mcp-fixture-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        copy_dir(&src, &root);
        let root = root.canonicalize().unwrap();
        let mut ts = None;
        let refs = |ts: &mut Option<Sidecar>| {
            semantic(&root, ts, "find_references", &json!({"symbol": "getUser", "file": "src/lib/user.ts"})).unwrap()
        };

        let r = refs(&mut ts);
        for want in ["fetchUser(1)", "from \"./lib\"", "from \"@lib/user\"", "map(getUser)", "return getUser(0)"] {
            assert!(r.contains(want), "missing {want}:\n{r}");
        }
        assert!(!r.contains("other.ts") && !r.contains("comment"), "{r}");

        let amb = semantic(&root, &mut ts, "go_to_definition", &json!({"symbol": "getUser"})).unwrap();
        assert!(amb.contains("matches 2 declarations"), "{amb}");

        // Edit on disk is seen by the next call without a restart.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("src/b.ts"), "import { getUser } from \"./lib\";\nexport const late = getUser(9);\n").unwrap();
        assert!(refs(&mut ts).contains("late = getUser(9)"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ts_monorepo_references_cross_packages() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/monorepo").canonicalize().unwrap();
        let mut ts = None;
        let r = semantic(&root, &mut ts, "find_references", &json!({"symbol": "formatName"})).unwrap();
        assert!(r.contains("packages/app/src/main.ts") && r.contains("formatName(\" app \")"), "{r}");
        let p = semantic(&root, &mut ts, "ts_projects", &json!({})).unwrap();
        assert!(p.contains("packages/core/tsconfig.json  1 files") && p.contains("tsconfig.json  no files"), "{p}");
    }

    #[test]
    fn ts_installing_a_package_clears_stale_resolution() {
        let root = std::env::temp_dir().join(format!("project-mcp-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture"), &root);
        std::fs::write(root.join("src/pkg.ts"), "import { x } from \"fake-pkg\";\nexport const y: number = x;\n").unwrap();
        let root = root.canonicalize().unwrap();
        let mut ts = None;
        let diag = |ts: &mut Option<Sidecar>| semantic(&root, ts, "diagnostics", &json!({"path": "src/pkg.ts"})).unwrap();

        assert!(diag(&mut ts).contains("TS2307"));
        let pkg = root.join("node_modules/fake-pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name": "fake-pkg", "types": "index.d.ts"}"#).unwrap();
        std::fs::write(pkg.join("index.d.ts"), "export declare const x: number;\n").unwrap();
        let after = diag(&mut ts);
        assert!(after.starts_with("no errors"), "{after}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ts_extends_base_config_change_is_seen() {
        let root = std::env::temp_dir().join(format!("project-mcp-extends-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture"), &root);
        std::fs::write(root.join("tsconfig.base.json"), r#"{"compilerOptions": {"noImplicitAny": false}}"#).unwrap();
        std::fs::write(root.join("tsconfig.json"), r#"{"extends": "./tsconfig.base.json", "compilerOptions": {"strict": true, "noEmit": true}, "include": ["src"]}"#).unwrap();
        std::fs::write(root.join("src/imp.ts"), "export function f(x) { return x; }\n").unwrap();
        let root = root.canonicalize().unwrap();
        let mut ts = None;
        let diag = |ts: &mut Option<Sidecar>| semantic(&root, ts, "diagnostics", &json!({"path": "src/imp.ts"})).unwrap();

        assert!(diag(&mut ts).starts_with("no errors"));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("tsconfig.base.json"), "{}").unwrap();
        let after = diag(&mut ts);
        assert!(after.contains("TS7006"), "{after}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ts_call_flow_follows_checker_and_implementations() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture").canonicalize().unwrap();
        let mut ts = None;
        let f = semantic(&root, &mut ts, "call_flow", &json!({"symbol": "handle", "file": "src/flow.ts"})).unwrap();
        // Statements chained in order; the interface call resolves to its only implementation.
        for want in [
            "flowchart TD",
            "c0([\"handle\"])",
            "c1[\"const v = repo.find(id);\"]",
            "c2{\"if (!v)\"}",
            "c2 -->|\"yes\"| c3",
            "c2 -->|\"no\"| c4",
            "c3 --> c4",
            "c4([\"return format(v ?? #quot;#quot;)\"])",
            "### memRepo.find (implements Repo.find)",
            "### audit",
        ] {
            assert!(f.contains(want), "missing {want}:\n{f}");
        }
        assert!(!f.contains("### logger"), "a value from elsewhere is not a callee:\n{f}");
        // `throw new NotFound(…)` (an Error subclass, per the checker) is a red end; its constructor's callees aren't listed.
        let m = semantic(&root, &mut ts, "call_flow", &json!({"symbol": "must", "file": "src/flow.ts"})).unwrap();
        assert!(m.contains("([\"throw new NotFound(id)\"]):::error") && m.contains("### new NotFound (error)") && !m.contains("### describe"), "{m}");
        // Control flow: statements chained in order, if/loop/try as branches, returns as ends.
        let c = semantic(&root, &mut ts, "call_flow", &json!({"symbol": "checkout", "file": "src/flow.ts", "format": "json"})).unwrap();
        let c: Value = serde_json::from_str(&c).unwrap();
        let cf = c["mermaid"].as_str().unwrap();
        for want in [
            "c1[\"const first = must(repo, ids[0]);\"]",
            "c2{\"for (const id of ids)\"}",
            "c1 --> c2",
            "c2 -->|\"each\"| c3",
            "c3 --> c2",
            "c4{\"if (first.length #gt; 3)\"}",
            "c2 -->|\"done\"| c4",
            "c4 -->|\"yes\"| c5",
            "c5([\"return format(first)\"])",
            "c4 -->|\"no\"| ",
            "-.->|\"on error\"|",
            "c9([\"return first\"])",
        ] {
            assert!(cf.contains(want), "missing {want}:\n{cf}");
        }
        let step = c["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "c1").unwrap();
        assert_eq!(step["callees"][0]["name"], "must");
        assert_eq!(step["callees"][0]["line"], 37);

        // A return inside a callback resumes the outer function, it doesn't end the flow.
        let w = semantic(&root, &mut ts, "call_flow", &json!({"symbol": "withCallback", "file": "src/flow.ts", "format": "json"})).unwrap();
        let w: Value = serde_json::from_str(&w).unwrap();
        let wf = w["mermaid"].as_str().unwrap();
        let last = w["nodes"].as_array().unwrap().iter().find(|n| n["label"] == "return format(v)").unwrap()["id"].as_str().unwrap().to_string();
        let hit = w["nodes"].as_array().unwrap().iter().find(|n| n["label"] == "return \"hit\"").unwrap()["id"].as_str().unwrap().to_string();
        assert!(wf.contains(&format!("{hit} --> ")), "callback return must continue:\n{wf}");
        assert!(wf.contains(&format!("--> {last}")), "{wf}");

        // Entry by line inside the function also works.
        let by_line = semantic(&root, &mut ts, "call_flow", &json!({"file": "src/flow.ts", "line": 21})).unwrap();
        assert!(by_line.contains("([\"handle"), "{by_line}");
    }

    #[test]
    fn url_args_round_trip() {
        let a = json!({"symbol": "a b/ç&x", "line": 12, "includeTests": true});
        let url = flow_url(1, &a);
        let back = query_args(url.split_once('?').unwrap().1);
        assert_eq!(back, a);
        assert_eq!(pct_decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn web_serves_flow_page_and_rejects_foreign_host() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture").canonicalize().unwrap();
        let port = start_web(root, Arc::new(Mutex::new(None))).unwrap();
        let get = |path: &str, host: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
            let mut body = String::new();
            s.read_to_string(&mut body).unwrap();
            body
        };
        let page = get("/flow?symbol=handle&file=src/flow.ts", &format!("127.0.0.1:{port}"));
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("\"name\":\"memRepo.find\""), "{}", &page[..page.len().min(400)]);
        assert!(get("/mermaid.js", &format!("localhost:{port}")).starts_with("HTTP/1.1 200"));
        assert!(get("/flow?symbol=handle", "evil.example:80").starts_with("HTTP/1.1 403"));
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().map(Result::unwrap) {
            let dst = to.join(e.file_name());
            if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &dst) } else { std::fs::copy(e.path(), dst).unwrap(); }
        }
    }

    #[test]
    fn resolve_rejects_escape() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert!(resolve(&root, Some("..")).is_err());
        assert!(resolve(&root, Some("src")).is_ok());
    }
}
