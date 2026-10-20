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
| `ts_projects` | tsconfig projects found, file counts, TS version |

Semantic tools take `symbol`, plus `file` (and `line`) when the name is ambiguous, or `file` + `line` + `column`.
An ambiguous name returns the list of candidates instead of guessing.

## How the semantic tools work

- On the first semantic call the server starts `bun sidecar/ts.cjs <root>`, which builds a TypeScript `LanguageService` from the project's `tsconfig.json` (`include`/`exclude`, `paths`, `extends`). It stays in memory for the session: first call takes a moment, later ones are near-instant.
- File versions are their mtime, so edits on disk are picked up on the next call without a restart; the file list is rescanned every 5 s or when an unknown file is requested.
- The project's own `typescript` is used when it has the JS LanguageService (TS < 7). TypeScript 7 (native) has no such API, so those projects use the bundled TypeScript 6.0.3.
- Monorepos: every `tsconfig.json` under the root (skipping `node_modules`, `dist`, `build`…) plus their `references` becomes its own project with its own LanguageService, built on first use and freed after 10 min idle. A file belongs to the deepest tsconfig that includes it. `find_references`, `rename_preview` and `incoming_calls` run in every project that sees the file and merge results, so usages in other packages are found (sources of referenced projects are used, like tsserver). Solution-style configs (`"files": []`) are skipped. `ts_projects` shows what was found.
- It runs alongside VSCode's tsserver, not shared with it.

## Test

```sh
cargo test
```

`tests/fixture` covers renamed imports, barrel re-exports, `paths` aliases, default exports, same-named symbols, comments and on-disk edits. `tests/monorepo` covers a solution-style root with two referenced packages.
