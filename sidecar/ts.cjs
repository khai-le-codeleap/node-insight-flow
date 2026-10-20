// project-mcp sidecar: TypeScript LanguageService over newline-delimited JSON on stdio.
// Request: {"id", "tool", "args"}  Reply: {"id", "text"} | {"id", "error"}
// Monorepos: one LanguageService per tsconfig (built lazily, freed when idle); a file belongs to the
// deepest tsconfig that includes it; references/rename/callers are merged across every project that sees the file.
"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const root = fs.realpathSync(process.argv[2] || process.cwd());
const ts = loadTs();
const RESCAN_MS = 5000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_LINE_CHARS = 200;
const SKIP_DIRS = ["**/node_modules", "**/.git", "**/dist", "**/build", "**/out", "**/coverage"];
const ENV_FILES = ["node_modules", "package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

// Prefer the project's own TypeScript so results match VSCode. TS >= 7 (native) has no JS
// LanguageService, so fall back to the bundled 6.x.
function loadTs() {
  try {
    const own = require(require.resolve("typescript", { paths: [root] }));
    if (typeof own.createLanguageService === "function") return own;
  } catch {}
  return require(require.resolve("typescript", { paths: [__dirname] }));
}

const registry = ts.createDocumentRegistry(); // shares parsed files between projects

// ---------- projects ----------

class Project {
  /** @param {string|null} config tsconfig path, or null for an inferred project of all JS/TS under root */
  constructor(config) {
    this.config = config;
    this.ls = null;
    this.lastUsed = 0;
    this.refresh();
  }

  refresh() {
    this.options = {};
    this.fileNames = [];
    this.references = [];
    this.error = null;
    try {
      if (this.config) {
        const { config, error } = ts.readConfigFile(this.config, ts.sys.readFile);
        if (error) throw new Error(flat(error.messageText));
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(this.config), undefined, this.config);
        this.options = parsed.options;
        this.fileNames = parsed.fileNames;
        this.references = parsed.projectReferences ?? [];
      } else {
        this.options = { allowJs: true, noEmit: true };
        this.fileNames = ts.sys.readDirectory(root, [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"], SKIP_DIRS);
      }
    } catch (e) {
      this.error = String(e?.message ?? e); // a broken tsconfig must not take the other packages down
    }
    this.fileSet = new Set(this.fileNames);
    this.scanned = Date.now();
    this.stamp = this.envStamp();
  }

  /**
   * mtimes of what module resolution depends on besides sources: the tsconfig, and node_modules,
   * package.json and lockfiles from the project dir up to root.
   * shortcut: `extends` targets aren't tracked, add them if edits to a shared base config go unseen.
   */
  envStamp() {
    const files = this.config ? [this.config] : [];
    for (let d = this.config ? path.dirname(this.config) : root; ; d = path.dirname(d)) {
      for (const f of ENV_FILES) files.push(path.join(d, f));
      if (d === root || !d.startsWith(root + path.sep)) break;
    }
    return files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
  }

  /**
   * Rebuild from scratch when deps or config changed (TS keeps failed module resolutions of unchanged
   * files forever), else re-read the file list when stale (new/deleted files).
   */
  fresh() {
    if (this.envStamp() !== this.stamp) {
      this.ls?.dispose();
      this.ls = null;
      this.refresh();
    } else if (Date.now() - this.scanned > RESCAN_MS) {
      this.refresh();
    }
    return this;
  }

  get service() {
    this.lastUsed = Date.now();
    if (!this.ls) {
      const self = this;
      this.ls = ts.createLanguageService(
        {
          getScriptFileNames: () => self.fileNames,
          // mtime as version: only changed files get re-parsed, and answers never use stale code.
          getScriptVersion: (f) => {
            try { return String(fs.statSync(f).mtimeMs); } catch { return "0"; }
          },
          getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")) : undefined),
          getCurrentDirectory: () => (self.config ? path.dirname(self.config) : root),
          getCompilationSettings: () => self.options,
          getProjectReferences: () => self.references,
          // Like tsserver: use referenced projects' sources, not their built .d.ts.
          useSourceOfProjectReferenceRedirect: () => true,
          getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
          fileExists: ts.sys.fileExists,
          readFile: ts.sys.readFile,
          readDirectory: ts.sys.readDirectory,
          directoryExists: ts.sys.directoryExists,
          getDirectories: ts.sys.getDirectories,
          realpath: ts.sys.realpath, // workspace packages are symlinks in node_modules
        },
        registry,
      );
    }
    return this.ls;
  }

  /** Program for this request (getProgram() re-stats every file, so call it once per request). */
  get program() {
    if (!req.programs.has(this)) req.programs.set(this, this.service.getProgram());
    return req.programs.get(this);
  }

  get depth() {
    return this.config ? path.dirname(this.config).split(path.sep).length : 0;
  }
}

/** configPath (or "" for inferred) -> Project */
const projects = new Map();
let discovered = 0;

function discover() {
  let configs = ts.sys.readDirectory(root, [".json"], SKIP_DIRS, ["**/tsconfig.json"]);
  if (!configs.length) {
    const up = ts.findConfigFile(root, ts.sys.fileExists); // opened inside a package
    if (up) configs = [up];
  }
  // Follow references too (tsconfig.app.json, tsconfig.lib.json, ...).
  const seen = new Set();
  const queue = configs.map((c) => path.resolve(c));
  while (queue.length) {
    const c = queue.pop();
    if (seen.has(c) || !fs.existsSync(c)) continue;
    seen.add(c);
    if (!projects.has(c)) projects.set(c, new Project(c));
    for (const r of projects.get(c).references) queue.push(ts.resolveProjectReferencePath(r));
  }
  for (const k of projects.keys()) if (k && !seen.has(k)) projects.get(k).ls?.dispose(), projects.delete(k);
  const any = [...seen].some((c) => projects.get(c).fileNames.length);
  if (!any && !projects.has("")) projects.set("", new Project(null));
  if (any) projects.delete("");
  discovered = Date.now();
}

/** Projects with files, deepest tsconfig first. Solution-style configs (`files: []`) drop out here. */
function active() {
  if (Date.now() - discovered > RESCAN_MS) discover();
  return [...projects.values()].map((p) => p.fresh()).filter((p) => p.fileNames.length).sort((a, b) => b.depth - a.depth);
}

/** Projects that include `file`, deepest first. */
function owners(file, userPath) {
  let ps = active().filter((p) => p.fileSet.has(file));
  if (!ps.length) {
    discover(); // maybe a new file or package
    ps = active().filter((p) => p.fileSet.has(file));
  }
  if (!ps.length) throw new Error(`not in any tsconfig (check include/exclude): ${userPath ?? rel(file)}`);
  return ps;
}

/** Every project whose program contains `file`: its owners plus packages importing it. Builds all projects. */
function seers(file) {
  return active().filter((p) => p.fileSet.has(file) || p.program.getSourceFile(file));
}

// Free LanguageServices nobody asked for in a while.
setInterval(() => {
  for (const p of projects.values()) {
    if (p.ls && Date.now() - p.lastUsed > IDLE_MS) {
      p.ls.dispose();
      p.ls = null;
    }
  }
}, 60 * 1000).unref();

// ---------- helpers ----------

/** Per-request caches. */
let req = { programs: new Map(), files: new Map() };

const flat = (m) => ts.flattenDiagnosticMessageText(m, "\n");
const rel = (f) => path.relative(root, f) || ".";
const clip = (s) => (s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + "…" : s);

function sourceFile(f) {
  if (!req.files.has(f)) {
    let sf;
    for (const p of projects.values()) if (p.ls && (sf = p.program.getSourceFile(f))) break;
    sf ??= ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest);
    req.files.set(f, sf);
  }
  return req.files.get(f);
}

/** Path from the client, kept inside root (trust boundary). */
function abs(p) {
  const a = path.resolve(root, p);
  if (a !== root && !a.startsWith(root + path.sep)) throw new Error(`path outside project root: ${p}`);
  return a;
}

function lineText(sf, line) {
  const starts = sf.getLineStarts();
  return sf.text.slice(starts[line], starts[line + 1] ?? sf.text.length).replace(/\r?\n$/, "");
}

/** {file, line (1-based), text} for an offset. */
function at(file, pos) {
  const sf = sourceFile(file);
  const { line } = sf.getLineAndCharacterOfPosition(pos);
  return { file, line: line + 1, text: clip(lineText(sf, line).trim()) };
}

/** Unique by file:line, sorted. */
function uniq(hits) {
  const m = new Map(hits.map((h) => [`${h.file}:${h.line}`, h]));
  return [...m.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `path:line  text`, padded into a column. */
function fmt(hits) {
  const w = Math.max(0, ...hits.map((h) => `${rel(h.file)}:${h.line}`.length));
  return hits.map((h) => `${`${rel(h.file)}:${h.line}`.padEnd(w)}  ${h.text}`).join("\n");
}

/** File header, then `  line  text` under it. */
function grouped(hits) {
  const w = Math.max(0, ...hits.map((h) => String(h.line).length));
  let out = "";
  let cur;
  for (const h of hits) {
    if (h.file !== cur) out += `${rel((cur = h.file))}\n`;
    out += `  ${String(h.line).padStart(w)}  ${h.text}\n`;
  }
  return out.trimEnd();
}

// ---------- name -> position ----------

function namePos(item) {
  const p = sourceFile(item.fileName).text.indexOf(item.name, item.textSpan.start);
  return p >= 0 ? p : item.textSpan.start;
}

/** Resolve args to {file, pos, project}, or {ambiguous: items} when a name matches several declarations. */
function locate(a) {
  const file = a.file && abs(a.file);
  const ps = file ? owners(file, a.file) : active();
  if (!ps.length) throw new Error("no TypeScript/JavaScript files found");
  if (file && a.line && a.column) {
    const sf = ps[0].program.getSourceFile(file);
    return { file, project: ps[0], pos: sf.getPositionOfLineAndCharacter(a.line - 1, a.column - 1) };
  }
  if (!a.symbol) throw new Error("pass `symbol`, or `file` + `line` + `column`");

  // Search every candidate project; a file shared by several projects is listed once.
  const found = new Map();
  for (const p of ps) {
    for (const i of p.service.getNavigateToItems(a.symbol, 200, file, true)) {
      const k = `${i.fileName}:${i.textSpan.start}`;
      if (i.name === a.symbol && p.fileSet.has(i.fileName) && !found.has(k)) found.set(k, i);
    }
  }
  let items = [...found.values()];
  if (a.line) items = items.filter((i) => at(i.fileName, namePos(i)).line === a.line);

  if (items.length === 0 && file && a.line) {
    // Locals aren't in navigateTo: take the name on that line.
    const sf = sourceFile(file);
    const col = lineText(sf, a.line - 1).search(new RegExp(`\\b${a.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    if (col >= 0) return { file, project: ps[0], pos: sf.getLineStarts()[a.line - 1] + col };
  }
  if (items.length === 0) {
    throw new Error(`symbol not found: ${a.symbol}${file ? ` in ${a.file}` : ""} (for local variables pass file + line)`);
  }
  if (items.length > 1) return { ambiguous: items };
  const f = items[0].fileName;
  return { file: f, project: owners(f)[0], pos: namePos(items[0]) };
}

function ambiguous(name, items) {
  const hits = items.map((i) => {
    const h = at(i.fileName, namePos(i));
    return { ...h, text: `[${i.kind}${i.containerName ? ` in ${i.containerName}` : ""}]  ${h.text}` };
  });
  return `"${name}" matches ${items.length} declarations; call again with \`file\` (and \`line\`):\n${fmt(uniq(hits))}`;
}

// ---------- tools ----------

/** Wrap a tool that needs a position. */
const positional = (fn) => (a) => {
  const l = locate(a);
  return l.ambiguous ? ambiguous(a.symbol, l.ambiguous) : fn(l, a);
};

const tools = {
  go_to_definition: positional(({ file, pos, project }) => {
    const defs = project.service.getDefinitionAndBoundSpan(file, pos)?.definitions ?? [];
    return defs.length ? fmt(uniq(defs.map((d) => at(d.fileName, d.textSpan.start)))) : "no definition found";
  }),

  find_references: positional(({ file, pos }, a) => {
    const defs = [];
    const refs = [];
    for (const p of seers(file)) {
      for (const g of p.service.findReferences(file, pos) ?? []) {
        for (const r of g.references) (r.isDefinition ? defs : refs).push(at(r.fileName, r.textSpan.start));
      }
    }
    const u = uniq(refs);
    let out = "";
    if (a.includeDefinition !== false && defs.length) out += `declarations:\n${grouped(uniq(defs))}\n\n`;
    out += `references: ${u.length} lines in ${new Set(u.map((h) => h.file)).size} files\n${grouped(u)}`;
    return out.trimEnd();
  }),

  incoming_calls: positional(({ file, pos, project }, a) => {
    const depth = Math.min(Math.max(a.depth ?? 1, 1), 5);
    const items = [].concat(project.service.prepareCallHierarchy(file, pos) ?? []);
    if (!items.length) return "not a function or method at that position";
    const ps = seers(file);
    const out = [];
    const printed = new Set();
    const walked = new Set();
    const walk = (item, d) => {
      if (d > depth || printed.size >= 200) return;
      for (const p of ps) {
        if (!p.program.getSourceFile(item.file)) continue;
        for (const c of p.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
          const site = at(c.from.file, c.fromSpans[0]?.start ?? c.from.selectionSpan.start);
          const k = `${d}:${site.file}:${site.line}`;
          if (printed.has(k)) continue;
          printed.add(k);
          // Module-level callers are named by their absolute file path.
          const name = path.isAbsolute(c.from.name) ? "module" : c.from.name;
          out.push(`${"  ".repeat(d)}${rel(site.file)}:${site.line}  [${name}]  ${site.text}`);
          const w = `${c.from.file}:${c.from.selectionSpan.start}`;
          if (!walked.has(w)) {
            walked.add(w);
            walk(c.from, d + 1);
          }
        }
      }
    };
    for (const it of items) {
      const h = at(it.file, it.selectionSpan.start);
      out.push(`${it.name}  ${rel(h.file)}:${h.line}`);
      walk(it, 1);
    }
    if (!printed.size) out.push("  (no callers)");
    if (printed.size >= 200) out.push("… (stopped at 200 calls, lower depth)");
    return out.join("\n");
  }),

  type_info: positional(({ file, pos, project }) => {
    const q = project.service.getQuickInfoAtPosition(file, pos);
    if (!q) return "no type info at that position";
    const h = at(file, pos);
    let out = `${rel(h.file)}:${h.line}  ${h.text}\n\n${ts.displayPartsToString(q.displayParts)}`;
    const doc = ts.displayPartsToString(q.documentation ?? []);
    if (doc) out += `\n\n${doc}`;
    for (const t of q.tags ?? []) {
      out += `\n@${t.name} ${typeof t.text === "string" ? t.text : ts.displayPartsToString(t.text ?? [])}`;
    }
    return out;
  }),

  rename_preview: positional(({ file, pos, project }, a) => {
    if (!a.newName) throw new Error("newName is required");
    const info = project.service.getRenameInfo(file, pos, {});
    if (!info.canRename) throw new Error(info.localizedErrorMessage);
    const locs = new Map();
    for (const p of seers(file)) {
      for (const r of p.service.findRenameLocations(file, pos, false, false, { providePrefixAndSuffixTextForRename: true }) ?? []) {
        locs.set(`${r.fileName}:${r.textSpan.start}`, r);
      }
    }
    // file -> line -> edits
    const byFile = new Map();
    for (const r of locs.values()) {
      const { line } = sourceFile(r.fileName).getLineAndCharacterOfPosition(r.textSpan.start);
      if (!byFile.has(r.fileName)) byFile.set(r.fileName, new Map());
      const lines = byFile.get(r.fileName);
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line).push(r);
    }
    let out = `${locs.size} edits in ${byFile.size} files (preview only, nothing written)\n`;
    for (const f of [...byFile.keys()].sort()) {
      const sf = sourceFile(f);
      out += `${rel(f)}\n`;
      for (const [line, edits] of [...byFile.get(f)].sort((x, y) => x[0] - y[0])) {
        const old = lineText(sf, line);
        const start = sf.getLineStarts()[line];
        let neu = old;
        for (const e of edits.sort((x, y) => y.textSpan.start - x.textSpan.start)) {
          const s = e.textSpan.start - start;
          neu = neu.slice(0, s) + (e.prefixText ?? "") + a.newName + (e.suffixText ?? "") + neu.slice(s + e.textSpan.length);
        }
        const n = String(line + 1);
        out += `  ${n}  - ${clip(old.trim())}\n  ${" ".repeat(n.length)}  + ${clip(neu.trim())}\n`;
      }
    }
    return out.trimEnd();
  }),

  diagnostics(a) {
    const target = abs(a.path || ".");
    const max = a.maxResults ?? 50;
    // Each file is checked once, by its deepest tsconfig.
    const files = new Map();
    for (const p of active()) {
      for (const f of p.fileNames) if ((f === target || f.startsWith(target + path.sep)) && !files.has(f)) files.set(f, p);
    }
    if (!files.size) throw new Error(`no project files under ${a.path || "."}`);
    const out = [];
    outer: for (const [f, p] of [...files].sort((x, y) => x[0].localeCompare(y[0]))) {
      for (const d of [...p.service.getSyntacticDiagnostics(f), ...p.service.getSemanticDiagnostics(f)]) {
        if (out.length >= max) {
          out.push(`… (stopped at ${max}, narrow \`path\` or raise maxResults)`);
          break outer;
        }
        const cat = ts.DiagnosticCategory[d.category].toLowerCase();
        if (d.start === undefined) {
          out.push(`${rel(f)}  TS${d.code} ${cat}: ${flat(d.messageText)}`);
        } else {
          const h = at(f, d.start);
          out.push(`${rel(f)}:${h.line}  TS${d.code} ${cat}: ${flat(d.messageText)}\n    ${h.text}`);
        }
      }
    }
    return out.length ? out.join("\n") : `no errors in ${files.size} files`;
  },

  ts_projects() {
    const list = [...projects.values()].sort((a, b) => (a.config ?? "").localeCompare(b.config ?? ""));
    return list
      .map((p) => {
        const name = p.config ? rel(p.config) : "(inferred, no tsconfig)";
        const state = p.error ? `error: ${p.error}` : p.fileNames.length ? `${p.fileNames.length} files${p.ls ? ", loaded" : ""}` : "no files (solution-style or empty)";
        return `${name}  ${state}`;
      })
      .join("\n") + `\nTypeScript ${ts.version}`;
  },
};

// ---------- loop ----------

const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n");
discover();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let id = null;
  req = { programs: new Map(), files: new Map() };
  try {
    const r = JSON.parse(line);
    id = r.id;
    const fn = tools[r.tool];
    if (!fn) throw new Error(`unknown tool: ${r.tool}`);
    reply({ id, text: fn(r.args ?? {}) });
  } catch (e) {
    reply({ id, error: String(e?.message ?? e) });
  }
});
