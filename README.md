# project-mcp

MCP server (stdio) written in Rust. It adds what Claude Code's built-in Grep/Glob/Read can't do well:
semantic TypeScript navigation (like VSCode), section-level Markdown reading, and log summaries.

## Build

Requires Rust and [Bun](https://bun.sh).

```sh
cargo build --release
(cd sidecar && bun install)
```

## Use with Claude Code

```sh
claude mcp add --scope user project -- /path/to/project-mcp/target/release/project-mcp
```

The project root is the first argument, or the current directory (where `claude` runs). All paths are relative to it; paths escaping it are rejected.
The binary loads `sidecar/ts.cjs` from this repo, so keep the repo where it was built.

## Tools

| Tool | What it does |
|---|---|
| `project_overview` | Top-level entries, manifests, `package.json` scripts, file counts by extension |
| `list_docs` / `read_doc` | Markdown files with headings / one file or one section by heading |
| `list_logs` / `read_log` / `summarize_log` | Find `*.log` (even gitignored), tail with level filter, group repeated errors |
| `go_to_definition` | F12 |
| `find_references` | Shift+F12, grouped by file, declarations separated |
| `incoming_calls` | Call hierarchy, `depth` 1–5 |
| `type_info` | Hover: inferred type + JSDoc |
| `rename_preview` | Every `-old/+new` line a rename would produce; writes nothing |
| `diagnostics` | Type errors for a file or directory (`maxResults`) |
| `call_flow` | Control-flow chart of a function / API handler (Mermaid) plus the code of every function it calls. Built from the syntax tree and the type checker: calls resolved with `getResolvedSignature`, interface/service members followed to their implementation, unresolvable calls listed separately. Entry is the handler (`symbol`, or `file` + `line` inside an inline handler). The result starts with a `http://127.0.0.1:<port>/flow?…` link to an interactive page |
| `ts_projects` | tsconfig projects found, file counts, TS version |
| `ts_reload` | Rebuild all TS projects from scratch |

Semantic tools take `symbol`, plus `file` (and `line`) when the name is ambiguous, or `file` + `line` + `column`.
An ambiguous name returns the list of candidates instead of guessing.

## How the semantic tools work

- On `initialize` (when the root has a `tsconfig.json`, `jsconfig.json` or `package.json`; otherwise on the first semantic call) the server starts `bun sidecar/ts.cjs <root>`, which builds TypeScript `LanguageService`s from the `tsconfig.json` files (`include`/`exclude`, `paths`, `extends`) in the background. It stays in memory for the session, so even the first call is usually fast.
- File versions are their mtime, so edits on disk are picked up on the next call without a restart; the file list is rescanned every 5 s or when an unknown file is requested.
- When a project's `tsconfig.json` or its `extends` chain, or any `node_modules` (or `node_modules/@scope`), `package.json` or lockfile between its directory and the root changes (e.g. after `bun install` / `bun link`), its config is re-read and module resolution is redone, keeping already-parsed files. Otherwise TypeScript would keep reporting "Cannot find module" for packages installed after it started. For changes that touch none of those, `ts_reload` rebuilds everything.
- The project's own `typescript` is used when it has the JS LanguageService (TS < 7). TypeScript 7 (native) has no such API, so those projects use the bundled TypeScript 6.0.3.
- Monorepos: every `tsconfig.json` under the root (skipping `node_modules`, `dist`, `build`…) plus their `references` becomes its own project with its own LanguageService, built at startup (or on first use after being freed) and freed after 10 min idle. A file belongs to the deepest tsconfig that includes it. `find_references`, `rename_preview` and `incoming_calls` run in every project that sees the file and merge results, so usages in other packages are found (sources of referenced projects are used, like tsserver). Solution-style configs (`"files": []`) are skipped. `ts_projects` shows what was found.
- It runs alongside VSCode's tsserver, not shared with it.

## call_flow page

The chart is the entry function's control flow, built from its syntax tree: every statement that calls project code is a box, chained in source order; `if`/`switch`/loops are diamonds with `yes`/`no`/`case`/`each`/`done` edges; `try` blocks get an `on error` edge to their `catch`; `return`/`throw` end the flow (red when they produce an error); inline callbacks (`Effect.gen(function* …)`, `withTransaction(…)`) are dashed groups, and a `return` inside one resumes the outer flow. Clicking a box shows the statement and the code of what it calls, with **Open flow →** to drill into that function. Drilled-into pages carry the flow you started from, and show a **← Back to <API>** button that returns to it however deep you went. Shortcut: `break`/`continue` end their branch instead of jumping.

**Reached from** (above the start box) answers "what wraps this handler" — e.g. which middleware/auth it passes through — without framework knowledge: from `findReferences` of the function (an inline handler is used where it's written), each use is walked up the AST to the named declaration around it, recording every wrapping call (`.handle(…)`, `.middleware(X)`, `app.get("/x", auth, h)`, `.pipe(Layer.provide(AuthLive))`), the project values passed to those calls (with their code), and other calls on the same router object (`app.use(auth)`, identified by symbol). Then the same for that declaration, up to module level (max 8 levels / 30 boxes). Deciding which of those is auth is left to the reader. Imports, type positions and test files are skipped.

On the left, **Files** lists every file in the flow as a tree (single-child folders squashed, folders collapsible); a file holding several symbols of the flow gets a row per symbol, in source order, and arrows start and end on those rows, so links inside one file (`HttpLive → makeHttpLive`) show too. Its gutter has one **main path**: a thick line with numbered stations through the files a request passes on its way to the handler (the longest *reached from* chain, outermost first, ending at the handler's file). When the main path would have to turn back (up then down the tree), it continues in a new lane to the right, starting from a copy of the turning station with the same number, joined to the original. Every other arrow branches off the main path at its source station: thin blue = *calls into* (the handler calls a function defined in that file), orange dashed = *plugged in here* (a value defined in that file — middleware, auth, layer, config — is passed into the wiring at that station), purple dotted = *also used from* (the code is also registered or used from somewhere off the main path). Chips under each file say what arrives there and from which station, e.g. `② TenantHeaderAuthLive`; hover a chip or arrow for the full sentence (which call the value is passed into, which statement calls the function). Hover an arrow for its meaning; click a file to highlight its arrows and its boxes in the chart (clicking a box selects its file). Both side panels can be closed. Every code card and every file in the tree has an **Open in VS Code** link (`vscode://file/<abs path>:<line>`).

The page has pan/zoom (drag, pinch or ctrl + scroll, Fit) and a code sidebar that can be closed (remembered per browser). A callee that is an interface member with exactly one implementation is shown as that implementation (`implements Interface.member`); `new` of a class whose base chain reaches `Error` marks the statement red.

The first `call_flow` call binds an HTTP server on `127.0.0.1` (random port) inside the MCP process. The page URL carries the call's arguments, so every load or Reload re-runs the analysis against the current code. Mermaid is served from `sidecar/node_modules` (no CDN). Requests whose `Host` isn't `127.0.0.1:<port>` / `localhost:<port>` are refused, so other websites can't read your code through DNS rebinding.

## Test

```sh
cargo test
```

`tests/fixture` covers renamed imports, barrel re-exports, `paths` aliases, default exports, same-named symbols, comments and on-disk edits. `tests/monorepo` covers a solution-style root with two referenced packages.
