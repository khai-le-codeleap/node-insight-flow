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
    this.invalidated = false;
    this.refresh();
  }

  refresh() {
    this.options = {};
    this.fileNames = [];
    this.references = [];
    this.extended = [];
    this.error = null;
    try {
      if (this.config) {
        const json = ts.readJsonConfigFile(this.config, ts.sys.readFile);
        if (json.parseDiagnostics?.length) throw new Error(flat(json.parseDiagnostics[0].messageText));
        const parsed = ts.parseJsonSourceFileConfigFileContent(json, ts.sys, path.dirname(this.config), undefined, this.config);
        this.options = parsed.options;
        this.fileNames = parsed.fileNames;
        this.references = parsed.projectReferences ?? [];
        this.extended = json.extendedSourceFiles ?? []; // the `extends` chain
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
   * mtimes of what config and module resolution depend on besides sources: the tsconfig and its
   * `extends` chain, and node_modules (+ its @scope dirs, for `bun link`), package.json and lockfiles
   * from the project dir up to root.
   */
  envStamp() {
    const files = this.config ? [this.config, ...this.extended] : [];
    for (let d = this.config ? path.dirname(this.config) : root; ; d = path.dirname(d)) {
      for (const f of ENV_FILES) files.push(path.join(d, f));
      const nm = path.join(d, "node_modules");
      try {
        for (const e of fs.readdirSync(nm)) if (e.startsWith("@")) files.push(path.join(nm, e));
      } catch {}
      if (d === root || !d.startsWith(root + path.sep)) break;
    }
    return files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(",");
  }

  /**
   * When deps or config changed, re-read the config and have TS redo module resolution (it otherwise
   * keeps failed resolutions of unchanged files forever); parsed files are kept. Else re-read the
   * file list when stale (new/deleted files).
   */
  fresh() {
    if (this.envStamp() !== this.stamp) {
      this.refresh();
      this.invalidated = !!this.ls;
    } else if (Date.now() - this.scanned > RESCAN_MS) {
      this.refresh();
    }
    return this;
  }

  get service() {
    this.lastUsed = Date.now();
    if (this.ls && this.invalidated) {
      this.ls.getProgram(); // the sync that re-resolves; later syncs reuse resolutions again
      this.invalidated = false;
    }
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
          hasInvalidatedResolutions: () => self.invalidated,
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
  if (file && a.line && !a.symbol) {
    const sf = ps[0].program.getSourceFile(file);
    const indent = lineText(sf, a.line - 1).search(/\S/);
    return { file, project: ps[0], pos: sf.getLineStarts()[a.line - 1] + Math.max(indent, 0) };
  }
  if (!a.symbol) throw new Error("pass `symbol`, or `file` + `line` (+ `column`)");

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

// ---------- call flow ----------
// Everything here comes from the type checker and the AST: calls resolve via getResolvedSignature, interface
// members via getImplementationAtPosition, conditions from the syntax tree. Nothing is matched by text.

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
const isHolder = (n) => ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n);
const isMember = (n) => ts.isMethodSignature(n) || ts.isPropertySignature(n);
const TEST_FILE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|\/(__tests__|__mocks__)\//;
const inProject = (f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !/\.d\.[cm]?ts$/.test(f);

/** Deepest node containing pos. */
function nodeAt(sf, pos) {
  let found = sf;
  const visit = (n) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Name of the nearest named declaration around `n` (class, interface, type, variable, function). */
function ownerName(n) {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if ((ts.isClassLike(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
  }
}

function unitName(decl) {
  if (ts.isConstructorDeclaration(decl)) return `new ${decl.parent.name?.getText() ?? "(class)"}`;
  if (decl.name) {
    const owner = ownerName(decl);
    return owner ? `${owner}.${decl.name.getText()}` : decl.name.getText();
  }
  // Anonymous callback: named by the call it's passed to, e.g. handlers.handle("getKpi")
  const call = decl.parent;
  if (call && ts.isCallExpression(call)) {
    const lit = call.arguments.find(ts.isStringLiteralLike);
    const callee = call.expression.getText().replace(/\s+/g, "");
    return `${callee.length > 40 ? "…" + callee.slice(-40) : callee}(${lit ? JSON.stringify(lit.text) : "…"}) callback`;
  }
  return "(anonymous)";
}

/** A step of the flow: `body` is walked for calls; abstract units (interface members) dispatch to implementations. */
function unit(decl, body, abstract = false) {
  const sf = decl.getSourceFile();
  return { key: `${sf.fileName}:${decl.getStart(sf)}`, file: sf.fileName, decl, body, abstract, name: unitName(decl) };
}

/** `x` without parentheses / `as` / `satisfies` / `!` around it. */
function bare(e) {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** Declaration from the checker -> unit, or null when it isn't code of ours that runs. */
function unitFromDecl(d) {
  if (!d) return null;
  if (isHolder(d)) {
    if (!d.initializer) return unit(d, null, true); // declared, e.g. class field `run: () => void`
    // `const f = () => …` or a built function `const f = Effect.fn(…)` / `SqlSchema.findOne({…})`; anything else
    // (`const sql = yield* SqlClient`, `const x = other`) is a value from elsewhere, not a step.
    const init = bare(d.initializer);
    return isFn(init) || ts.isCallExpression(init) || ts.isNewExpression(init) || ts.isTaggedTemplateExpression(init)
      ? unit(d, d.initializer)
      : null;
  }
  if (isFn(d)) {
    const holder = isHolder(d.parent) && d.parent.initializer === d ? d.parent : d;
    return unit(holder, d.body ?? null, !d.body);
  }
  if (ts.isClassDeclaration(d)) {
    const ctor = d.members.find(ts.isConstructorDeclaration);
    return ctor ? unit(ctor, ctor.body ?? null) : unit(d, null);
  }
  for (let m = d; m && !ts.isSourceFile(m); m = m.parent) if (isMember(m)) return unit(m, null, true); // function-typed member
  return null;
}

/** What a call expression runs: {unit} | {external} | {unresolved}. */
function resolveCall(checker, call) {
  let d;
  try { d = checker.getResolvedSignature(call)?.declaration; } catch {}
  const found = (decl) => {
    const u = unitFromDecl(decl);
    return u ? { unit: u } : { external: true };
  };
  if (d && !ts.isJSDocSignature?.(d) && inProject(d.getSourceFile().fileName)) return found(d);
  // Wrapped functions (`const f = Effect.fn(…)`, `memoize(g)`): signature from a library, but the callee is ours.
  const expr = ts.isTaggedTemplateExpression(call) ? call.tag : call.expression;
  let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const vd = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (vd && inProject(vd.getSourceFile().fileName)) return found(vd);
  return d || vd ? { external: true } : { unresolved: true };
}

/** Whether `t` is a class whose inheritance chain reaches the built-in Error (checker base types, not names in our code). */
function isErrorType(checker, t) {
  const seen = new Set();
  const queue = [t];
  while (queue.length) {
    let x = queue.pop();
    x = x?.target ?? x; // TypeReference -> its class
    if (!x || seen.has(x)) continue;
    seen.add(x);
    const decl = x.symbol?.declarations?.[0];
    if (x.symbol?.name === "Error" && decl && !inProject(decl.getSourceFile().fileName)) return true;
    if (x.objectFlags & ts.ObjectFlags.ClassOrInterface) queue.push(...(checker.getBaseTypes(x) ?? []));
    if (x.flags & ts.TypeFlags.Intersection) queue.push(...x.types);
  }
  return false;
}

function calleeText(call) {
  const e = ts.isTaggedTemplateExpression(call) ? call.tag : call.expression;
  const t = ts.isPropertyAccessExpression(e) && e.getText().length > 40 ? `….${e.name.getText()}` : e.getText();
  return (ts.isNewExpression(call) ? "new " : "") + t.replace(/\s+/g, "");
}

function implementations(project, u, keep) {
  const sf = u.decl.getSourceFile();
  const name = u.decl.name ?? u.decl;
  const out = [];
  for (const l of project.service.getImplementationAtPosition(sf.fileName, name.getStart(sf)) ?? []) {
    if (!inProject(l.fileName) || !keep(l.fileName)) continue;
    let n = nodeAt(project.program.getSourceFile(l.fileName), l.textSpan.start);
    while (n && !ts.isSourceFile(n) && !isFn(n) && !isHolder(n)) n = n.parent;
    const impl = n && !ts.isSourceFile(n) ? unitFromDecl(n) : null;
    if (impl && !impl.abstract && impl.key !== u.key) out.push(impl);
  }
  return out;
}

/** Code of a unit with line numbers, at most maxLines. */
function codeOf(u, maxLines) {
  const sf = u.decl.getSourceFile();
  let n = u.decl;
  if (ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent) && n.parent.declarations.length === 1) n = n.parent.parent;
  const first = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const last = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
  const w = String(last + 1).length;
  const lines = [];
  for (let i = first; i <= Math.min(last, first + maxLines - 1); i++) lines.push(`${String(i + 1).padStart(w)} │ ${lineText(sf, i)}`);
  if (last - first + 1 > maxLines) lines.push(`${" ".repeat(w)} │ … ${last - first + 1 - maxLines} more lines`);
  return lines.join("\n");
}

// ---------- control flow ----------
// The entry function's statements as a flowchart: chained in source order, branches from if/switch/loops/try,
// ends at return/throw. Inline callbacks (Effect.gen(function* …), withTransaction(…)) become titled groups.

/** Source text on one line, clipped. */
const snippet = (n, max = 70) => {
  const t = n.getText().replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** A unit to show for a callee: interface members with one implementation resolve to it. */
function concrete(project, u, keep) {
  if (!u.abstract) return u;
  const impls = implementations(project, u, keep);
  return impls.length === 1 ? { ...impls[0], via: u.name } : u;
}

function calleeInfo(u, checker, call, maxLines) {
  const sf = u.decl.getSourceFile();
  const nameNode = u.decl.name ?? u.decl;
  const { line, character } = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
  return {
    name: u.name,
    location: `${rel(u.file)}:${line + 1}`,
    file: rel(u.file),
    line: line + 1,
    column: character + 1,
    via: u.via ?? null,
    abstract: u.abstract,
    error: ts.isNewExpression(call) && isErrorType(checker, checker.getTypeAtLocation(call)),
    code: codeOf(u, maxLines),
  };
}

function controlFlow(project, entry, a, keep) {
  const checker = project.program.getTypeChecker();
  const maxLines = a.maxLines ?? 60;
  const nodes = [];
  const edges = [];
  const groups = []; // {id, title, parent}
  const stack = [];
  // One entry per callback being built: its `return`s, which resume the outer flow after the callback.
  const returns = [];
  const unresolved = [];

  const add = (kind, label, at_, extra = {}) => {
    const sf = at_.getSourceFile();
    const first = sf.getLineAndCharacterOfPosition(at_.getStart(sf)).line;
    const last = sf.getLineAndCharacterOfPosition(at_.getEnd()).line;
    const lines = [];
    for (let i = first; i <= Math.min(last, first + 29); i++) lines.push(`${String(i + 1).padStart(String(last + 1).length)} │ ${lineText(sf, i)}`);
    if (last - first > 29) lines.push(`… ${last - first - 29} more lines`);
    const node = { id: `c${nodes.length}`, kind, label, group: stack.at(-1) ?? null, location: `${rel(sf.fileName)}:${first + 1}`, code: lines.join("\n"), callees: [], ...extra };
    nodes.push(node);
    return node.id;
  };
  const link = (exits, to) => {
    for (const x of exits) edges.push({ from: x.id, to, label: x.label ?? null, dashed: !!x.dashed });
  };

  /** Project calls in `n` outside nested functions, and the nested functions (callbacks) themselves. */
  function scan(n) {
    const calls = [];
    const callbacks = [];
    const visit = (c) => {
      if (isFn(c)) return void callbacks.push(c);
      ts.forEachChild(c, visit);
      if (ts.isCallExpression(c) || ts.isNewExpression(c) || ts.isTaggedTemplateExpression(c)) {
        const r = resolveCall(checker, c);
        if (r.unresolved) unresolved.push({ ...at(c.getSourceFile().fileName, c.getStart()), text: calleeText(c) });
        if (r.unit && keep(r.unit.file)) calls.push(calleeInfo(concrete(project, r.unit, keep), checker, c, maxLines));
      }
    };
    if (isFn(n)) callbacks.push(n);
    else visit(n);
    const seen = new Set();
    return { calls: calls.filter((c) => !seen.has(c.location) && seen.add(c.location)), callbacks };
  }

  /** Callback bodies as groups, chained after `exits`. */
  function callbacksOf(callbacks, exits) {
    for (const fn of callbacks) {
      const parent = fn.parent && ts.isCallExpression(fn.parent) ? fn.parent : null;
      const gid = `g${groups.length}`;
      groups.push({ id: gid, title: parent ? `${calleeText(parent)}(…)` : "callback", parent: stack.at(-1) ?? null });
      stack.push(gid);
      returns.push([]);
      const before = nodes.length;
      const out = ts.isBlock(fn.body) ? seq(fn.body.statements, exits) : expr(fn.body, exits, fn.body);
      const returned = returns.pop();
      stack.pop();
      if (nodes.length === before) groups.pop(); // nothing of ours inside
      else exits = [...out, ...returned];
    }
    return exits;
  }

  /** A plain statement/expression: one step if it calls our code, plus its callbacks. */
  function expr(n, exits, labelNode) {
    const { calls, callbacks } = scan(n);
    if (calls.length) {
      const id = add(calls.every((c) => c.error) ? "error" : "step", snippet(labelNode), labelNode, { callees: calls });
      link(exits, id);
      exits = [{ id }];
    }
    return callbacksOf(callbacks, exits);
  }

  function terminal(kind, s, exits) {
    const { calls, callbacks } = s.expression ? scan(s.expression) : { calls: [], callbacks: [] };
    exits = callbacksOf(callbacks, exits);
    // `return` inside a callback ends the callback, not the function: flow goes on after it.
    const resumes = kind === "return" && returns.length > 0;
    // `return yield* new XError(…)` / `return Effect.fail(new XError(…))`: an error outcome, shown red like throw.
    const failed = calls.some((c) => c.error);
    const id = add(resumes ? "resume" : kind, snippet(s).replace(/;$/, ""), s, { callees: calls, failed });
    link(exits, id);
    if (resumes) returns.at(-1).push({ id });
    return [];
  }

  function seq(stmts, exits) {
    for (const s of stmts) {
      if (!exits.length) break; // after return/throw: unreachable
      exits = stmt(s, exits);
    }
    return exits;
  }

  function stmt(s, exits) {
    if (ts.isBlock(s)) return seq(s.statements, exits);
    if (ts.isIfStatement(s)) {
      exits = expr(s.expression, exits, s.expression);
      const d = add("decision", `if (${snippet(s.expression, 60)})`, s.expression);
      link(exits, d);
      const yes = stmt(s.thenStatement, [{ id: d, label: "yes" }]);
      const no = s.elseStatement ? stmt(s.elseStatement, [{ id: d, label: "no" }]) : [{ id: d, label: "no" }];
      return [...yes, ...no];
    }
    if (ts.isReturnStatement(s)) return terminal("return", s, exits);
    if (ts.isThrowStatement(s)) return terminal("throw", s, exits);
    if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s)) {
      const head = s.getText().slice(0, s.statement.getStart() - s.getStart()).replace(/\s+/g, " ").trim();
      const d = add("decision", head.length > 70 ? head.slice(0, 69) + "…" : head, s);
      link(exits, d);
      link(stmt(s.statement, [{ id: d, label: "each" }]), d);
      return [{ id: d, label: "done" }];
    }
    if (ts.isDoStatement(s)) {
      const before = nodes.length;
      const inner = stmt(s.statement, exits);
      const d = add("decision", `while (${snippet(s.expression, 50)})`, s.expression);
      link(inner, d);
      const first = nodes[before]; // first step of the body, where "again" jumps back to
      if (first && first.id !== d) edges.push({ from: d, to: first.id, label: "again", dashed: false });
      return [{ id: d, label: "done" }];
    }
    if (ts.isSwitchStatement(s)) {
      exits = expr(s.expression, exits, s.expression);
      const d = add("decision", `switch (${snippet(s.expression, 50)})`, s.expression);
      link(exits, d);
      let out = [];
      let hasDefault = false;
      for (const c of s.caseBlock.clauses) {
        hasDefault ||= ts.isDefaultClause(c);
        const label = ts.isDefaultClause(c) ? "default" : `case ${snippet(c.expression, 30)}`;
        out.push(...seq(c.statements, [{ id: d, label }]));
      }
      if (!hasDefault) out.push({ id: d, label: "other" });
      return out;
    }
    if (ts.isTryStatement(s)) {
      const gid = `g${groups.length}`;
      groups.push({ id: gid, title: "try", parent: stack.at(-1) ?? null });
      stack.push(gid);
      const before = nodes.length;
      let out = seq(s.tryBlock.statements, exits);
      stack.pop();
      const empty = nodes.length === before;
      if (empty) groups.pop();
      if (s.catchClause) {
        const c = add("catch", `catch${s.catchClause.variableDeclaration ? ` (${snippet(s.catchClause.variableDeclaration, 30)})` : ""}`, s.catchClause);
        // Any statement in the try block may throw: the edge leaves the whole group.
        if (empty) link(exits, c);
        else edges.push({ from: gid, to: c, label: "on error", dashed: true });
        out = [...out, ...seq(s.catchClause.block.statements, [{ id: c }])];
      }
      if (s.finallyBlock) out = seq(s.finallyBlock.statements, out);
      return out;
    }
    if (ts.isLabeledStatement(s)) return stmt(s.statement, exits);
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) return exits;
    // shortcut: break/continue just end the branch's statements, they don't jump to the loop exit/head.
    return expr(s, exits, s);
  }

  const start = add("start", entry.name, entry.decl);
  let exits = [{ id: start }];
  // `const f = (…) => …`: the entry's body is the arrow's body, not a callback.
  const body = entry.body && isFn(entry.body) ? entry.body.body : entry.body;
  exits = ts.isBlock(body) ? seq(body.statements, exits) : expr(body, exits, body);
  if (exits.length) link(exits, add("end", "end", entry.decl));

  // ---- mermaid ----
  const esc = (t) => t.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/`/g, "#96;");
  const shape = (n) => {
    const l = esc(n.label);
    if (n.kind === "start" || n.kind === "end" || n.kind === "return" || n.kind === "throw") return `([\"${l}\"])`;
    if (n.kind === "decision") return `{\"${l}\"}`;
    if (n.kind === "resume") return `(\"${l}\")`;
    if (n.kind === "catch") return `[/\"${l}\"/]`;
    return `[\"${l}\"]`;
  };
  const out = ["flowchart TD", "  classDef error stroke:#d9534f,stroke-width:2px,color:#d9534f"];
  const emit = (parent, indent) => {
    for (const n of nodes.filter((x) => x.group === parent)) {
      out.push(`${indent}${n.id}${shape(n)}${n.kind === "throw" || n.kind === "error" || n.failed ? ":::error" : ""}`);
    }
    for (const g of groups.filter((x) => x.parent === parent)) {
      out.push(`${indent}subgraph ${g.id}[\"${esc(g.title)}\"]`, `${indent}  direction TB`);
      emit(g.id, indent + "  ");
      out.push(`${indent}end`, `${indent}style ${g.id} fill:none,stroke-dasharray:4 3`);
    }
  };
  emit(null, "  ");
  for (const e of edges) {
    const arrow = e.dashed ? "-.->" : "-->";
    out.push(`  ${e.from} ${arrow}${e.label ? `|\"${esc(e.label)}\"|` : ""} ${e.to}`);
  }
  return { mermaid: out.join("\n"), nodes, groups, unresolved };
}

// ---------- reached from ----------
// Where the entry is used, walked upward: the calls wrapping each use up to the named declaration around it
// (`.handle(…)`, `.middleware(X)`, `app.get("/x", auth, h)`), project values passed to those calls, other calls on the
// same router object, then the same for that declaration, up to module level. From findReferences + the AST only.

const inside = (n, outer) =>
  n.getSourceFile() === outer.getSourceFile() && n.getStart() >= outer.getStart() && n.getEnd() <= outer.getEnd();
const hasAncestor = (n, pred) => {
  for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) if (pred(p)) return true;
  return false;
};

/** An argument in brief; calls shown `depth` levels deep, e.g. `Layer.provide(BearerAuthLive)`. */
function argSummary(a, depth = 2) {
  if (ts.isStringLiteralLike(a)) return JSON.stringify(a.text);
  if (ts.isNumericLiteral(a)) return a.text;
  if ((ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) && a.getText().length <= 40) return a.getText().replace(/\s+/g, "");
  if (depth > 0 && (ts.isCallExpression(a) || ts.isNewExpression(a))) return callSummary(a, false, depth - 1);
  return "…";
}

/** `router.get("/x", auth, h)`; `.middleware(X)` for a method on a chain (`a.b(…).middleware(X)`). */
function callSummary(call, viaReceiver, depth = 2) {
  const e = call.expression;
  const chained = ts.isPropertyAccessExpression(e) && (viaReceiver || ts.isCallExpression(e.expression) || e.expression.getText().length > 40);
  const callee = chained ? `.${e.name.text}` : calleeText(call);
  const t = `${callee}(${(call.arguments ?? []).map((x) => argSummary(x, depth)).join(", ")})`;
  return t.length > 200 ? t.slice(0, 199) + "…" : t;
}

/** Project declaration an identifier / property access refers to, through import aliases. */
function declOf(checker, expr) {
  let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
  return d && inProject(d.getSourceFile().fileName) ? d : null;
}

/** Statement-level node to show for a declaration. */
function statementOf(d) {
  let n = d;
  while (n.parent && !ts.isSourceFile(n.parent) && !ts.isBlock(n.parent) && !ts.isClassLike(n.parent) && !ts.isObjectLiteralExpression(n.parent)) n = n.parent;
  return n;
}

/** Up to `radius` lines either side of `focus`, within `n`, the focus line marked. */
function codeAround(n, focus, radius = 8) {
  const sf = n.getSourceFile();
  const first = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const last = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
  const f = sf.getLineAndCharacterOfPosition(focus).line;
  const from = Math.max(first, f - radius);
  const to = Math.min(last, f + radius);
  const w = String(to + 1).length;
  const lines = [];
  if (from > first) lines.push(`${" ".repeat(w)}   …`);
  for (let i = from; i <= to; i++) lines.push(`${String(i + 1).padStart(w)} ${i === f ? "▶" : "│"} ${lineText(sf, i)}`);
  if (to < last) lines.push(`${" ".repeat(w)}   …`);
  return lines.join("\n");
}

/** Where `u` is used (not imports, types, or its own body). An inline callback is used right where it's written. */
function usageSites(p, u, keep) {
  if (!u.decl.name) return isFn(u.decl) ? [{ n: u.decl, p }] : [];
  const sf = u.decl.getSourceFile();
  const sites = new Map();
  for (const q of seers(sf.fileName)) {
    for (const g of q.service.findReferences(sf.fileName, u.decl.name.getStart(sf)) ?? []) {
      for (const r of g.references) {
        if (r.isDefinition || !inProject(r.fileName) || !keep(r.fileName)) continue;
        const rsf = q.program.getSourceFile(r.fileName);
        if (!rsf) continue;
        const n = nodeAt(rsf, r.textSpan.start);
        if (rsf.fileName === sf.fileName && inside(n, u.decl)) continue;
        if (hasAncestor(n, (x) => ts.isImportDeclaration(x) || ts.isExportDeclaration(x) || ts.isImportEqualsDeclaration(x) || ts.isTypeNode(x))) continue;
        sites.set(`${r.fileName}:${r.textSpan.start}`, { n, p: q });
      }
    }
  }
  return [...sites.values()];
}

/** Calls on the same object as `call`'s receiver elsewhere (`app.use(auth)` next to `app.get(…)`). */
function siblingCalls(p, call, chain) {
  const e = call.expression;
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return [];
  const d = declOf(p.program.getTypeChecker(), e.expression);
  if (!d || !(ts.isVariableDeclaration(d) || ts.isParameter(d))) return []; // an object we own, not a namespace/class
  const sf = e.getSourceFile();
  const out = [];
  for (const g of p.service.findReferences(sf.fileName, e.expression.getStart(sf)) ?? []) {
    for (const r of g.references) {
      const rsf = p.program.getSourceFile(r.fileName);
      const id = rsf && nodeAt(rsf, r.textSpan.start);
      const pa = id?.parent;
      const c = pa?.parent;
      if (!pa || !ts.isPropertyAccessExpression(pa) || pa.expression !== id || !c || !ts.isCallExpression(c) || c.expression !== pa) continue;
      if (chain.includes(c)) continue;
      out.push({ location: `${rel(r.fileName)}:${at(r.fileName, c.getStart()).line}`, text: snippet(c, 80) });
    }
  }
  return out.slice(0, 20);
}

/** From a use up to the declaration (or top-level statement) around it, with the calls in between. */
function containerOf(site, p, keep) {
  const checker = p.program.getTypeChecker();
  const chain = [];
  const calls = [];
  const args = new Map();
  let prev = site;
  for (let n = site.parent; n; prev = n, n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callsEntry = n.expression === prev && (prev === site || (ts.isPropertyAccessExpression(prev) && prev.name === site));
      if (!callsEntry) {
        // Came up through `x.method`: the chain continues on x, show just `.method(…)`.
        const viaReceiver = n.expression === prev && ts.isPropertyAccessExpression(prev);
        chain.push(n);
        calls.push(callSummary(n, viaReceiver));
        // Project values anywhere in the wrapping call's arguments (not inside callbacks, not the path we came up).
        const ids = [];
        const collect = (x) => {
          if (isFn(x) || inside(prev, x)) return;
          if (ts.isIdentifier(x)) ids.push(x);
          ts.forEachChild(x, collect);
        };
        for (const a of n.arguments ?? []) collect(a);
        for (const a of ids) {
          const d = declOf(checker, a);
          if (!d || !keep(d.getSourceFile().fileName) || inside(a, d)) continue;
          if (ts.isParameter(d) || hasAncestor(a, (x) => x === d)) continue; // a callback's own parameter
          const dn = d.name ?? d;
          const pos = d.getSourceFile().getLineAndCharacterOfPosition(dn.getStart());
          args.set(`${d.getSourceFile().fileName}:${d.getStart()}`, {
            name: ts.isPropertyAccessExpression(a.parent) && a.parent.name === a ? a.parent.getText() : a.getText(),
            location: `${rel(d.getSourceFile().fileName)}:${pos.line + 1}`,
            file: rel(d.getSourceFile().fileName),
            line: pos.line + 1,
            column: pos.character + 1,
            fn: !!unitFromDecl(d)?.body,
            code: codeAround(statementOf(d), dn.getStart(), 15),
          });
        }
      }
    }
    const named = ((isHolder(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) || ts.isMethodDeclaration(n);
    if (named || (n.parent && ts.isSourceFile(n.parent))) {
      const siblings = chain.flatMap((c) => siblingCalls(p, c, chain));
      return { decl: named ? n : null, stmt: statementOf(n), calls, args: [...args.values()], siblings };
    }
  }
  return null;
}

function reachedFrom(project, entry, keep) {
  const out = [];
  const byKey = new Map();
  let frontier = [{ u: entry, p: project, child: "c0" }];
  for (let level = 0; level < 8 && frontier.length && out.length < 30; level++) {
    const next = [];
    for (const { u, p, child } of frontier) {
      for (const { n: site, p: sp } of usageSites(p, u, keep)) {
        const c = containerOf(site, sp, keep);
        if (!c) continue;
        const holder = c.decl ?? c.stmt;
        const file = holder.getSourceFile().fileName;
        const key = `${file}:${holder.getStart()}`;
        let r = byKey.get(key);
        if (!r) {
          r = {
            id: `r${out.length}`,
            name: c.decl ? unitName(c.decl) : `${path.basename(file)} (module)`,
            location: `${rel(file)}:${at(file, site.getStart()).line}`,
            registers: child,
            edges: [],
            calls: c.calls,
            args: c.args,
            siblings: c.siblings,
            code: codeAround(c.stmt, site.getStart()),
          };
          byKey.set(key, r);
          out.push(r);
          if (c.decl) next.push({ u: { decl: c.decl }, p: sp, child: r.id });
        }
        if (!r.edges.some((e) => e.to === child)) r.edges.push({ to: child, label: c.calls.join(" → ") });
      }
    }
    frontier = next;
  }
  return out;
}

function callFlow(project, entry, a) {
  const keep = (f) => a.includeTests || !TEST_FILE.test(f);
  const cf = controlFlow(project, entry, a, keep);
  const regs = reachedFrom(project, entry, keep);
  const esc = (t) => t.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/`/g, "#96;");
  let mermaid = cf.mermaid;
  if (regs.length) {
    const lines = ["  subgraph reached[\"reached from\"]", "    direction TB"];
    for (const r of regs) lines.push(`    ${r.id}[/\"${esc(r.name)}<br/>${esc(r.location.split("/").pop())}\"\\]`);
    lines.push("  end", "  style reached fill:none,stroke-dasharray:4 3");
    for (const r of regs) {
      for (const e of r.edges) {
        const label = e.label.length > 90 ? e.label.slice(0, 89) + "…" : e.label;
        lines.push(`  ${r.id} -->${label ? `|\"${esc(label)}\"|` : ""} ${e.to}`);
      }
    }
    mermaid += "\n" + lines.join("\n");
  }
  const data = {
    title: `flow of ${entry.name}`,
    entry: `${rel(entry.file)}:${at(entry.file, entry.decl.getStart()).line}`,
    code: codeOf(entry, a.maxLines ?? 60),
    mermaid,
    nodes: cf.nodes,
    reachedFrom: regs,
    unresolved: uniq(cf.unresolved).map((h) => ({ location: `${rel(h.file)}:${h.line}`, text: h.text })),
  };
  if (a.format === "json") return JSON.stringify(data);

  let out = `${data.title} (${data.entry})\n`;
  out += "(boxes = statements calling project code, in source order; diamonds = branches/loops; rounded ends = return/throw, red = error; dashed groups = inline callbacks)\n";
  out += "\n```mermaid\n" + data.mermaid + "\n```\n";
  const called = new Map();
  const steps = data.nodes.filter((n) => n.callees.length);
  if (steps.length) {
    out += "\nsteps:\n";
    for (const n of steps) {
      out += `${n.id}  ${n.location}  ${n.label}\n    calls: ${n.callees.map((c) => `${c.name} (${c.location})`).join(", ")}\n`;
      for (const c of n.callees) called.set(c.location, c);
    }
  }
  for (const c of called.values()) {
    const tags = [c.via && `implements ${c.via}`, c.abstract && "interface", c.error && "error"].filter(Boolean);
    out += `\n### ${c.name}${tags.length ? ` (${tags.join(", ")})` : ""} — ${c.location}\n` + "```ts\n" + c.code + "\n```\n";
  }
  if (regs.length) {
    out += "\nreached from (where this function is used, walked up to module level; wrapping calls innermost first):\n";
    for (const r of regs) {
      out += `${r.id} ${r.name} — ${r.location}  (uses ${r.registers})\n`;
      if (r.calls.length) out += `    wrapped by: ${r.calls.join(" → ")}\n`;
      for (const v of r.args) out += `    passes ${v.name} (${v.location})\n`;
      for (const s of r.siblings) out += `    same object: ${s.location}  ${s.text}\n`;
    }
  } else {
    out += "\nreached from: no uses found outside this function (or only in tests)\n";
  }
  if (data.unresolved.length) {
    out += `\nunresolved calls (no declaration known to the checker, e.g. \`any\`):\n`;
    out += data.unresolved.map((u) => `${u.location}  ${u.text}`).join("\n") + "\n";
  }
  return out.trimEnd();
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

  call_flow: positional(({ file, pos, project }, a) => {
    // Entry: the function-like (or `const f = …`) enclosing the position.
    let n = nodeAt(project.program.getSourceFile(file), pos);
    let entry = null;
    for (; n && !ts.isSourceFile(n) && !entry; n = n.parent) if (isFn(n) || isHolder(n)) entry = unitFromDecl(n);
    if (!entry || !entry.body) throw new Error("no function at that position; point at a function, method or inline handler");
    return callFlow(project, entry, a);
  }),

  ts_reload() {
    for (const p of projects.values()) {
      p.ls?.dispose();
      p.ls = null;
      p.refresh();
    }
    discover();
    return tools.ts_projects();
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
// Warm up: build every program now so the first tool call doesn't pay for it. Requests arriving
// meanwhile are queued, not lost.
setImmediate(() => {
  for (const p of active()) {
    try { p.service.getProgram().getTypeChecker(); } catch {}
  }
});
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
