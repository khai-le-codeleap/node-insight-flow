#!/bin/sh
# Install the latest node-insight-flow release into ~/.node-insight-flow and register it with
# Claude Code, Codex, VS Code (GitHub Copilot) and Cursor when they are installed.
#   curl -fsSL https://raw.githubusercontent.com/khai-le-codeleap/node-insight-flow/main/install.sh | sh
set -eu

repo=khai-le-codeleap/node-insight-flow
dir="${NODE_INSIGHT_FLOW_DIR:-$HOME/.node-insight-flow}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

command -v bun >/dev/null 2>&1 || echo "warning: Bun is required at runtime for the TypeScript tools: https://bun.sh" >&2

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="https://github.com/$repo/releases/latest/download/node-insight-flow-$target.tar.gz"
echo "downloading $url"
curl -fsSL "$url" -o "$tmp/a.tar.gz"
tar -xzf "$tmp/a.tar.gz" -C "$tmp"
rm -rf "$dir"
mv "$tmp/node-insight-flow" "$dir"
bin="$dir/node-insight-flow"
echo "installed $bin"

# Register with every MCP client found. VS Code and Cursor start servers outside the project, so they get
# ${workspaceFolder} as the root; Claude Code and Codex start them in the project directory.
name=node-insight-flow
found=0

if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user "$name" >/dev/null 2>&1 || true
  claude mcp add --scope user "$name" -- "$bin" && echo "registered: Claude Code (user scope)" && found=1
fi

if command -v codex >/dev/null 2>&1; then
  codex mcp remove "$name" >/dev/null 2>&1 || true
  codex mcp add "$name" -- "$bin" && echo "registered: Codex" && found=1
fi

for code in code code-insiders; do
  if command -v "$code" >/dev/null 2>&1; then
    "$code" --add-mcp "{\"name\":\"$name\",\"type\":\"stdio\",\"command\":\"$bin\",\"args\":[\"\${workspaceFolder}\"]}" >/dev/null &&
      echo "registered: VS Code / GitHub Copilot ($code, user profile)" && found=1
  fi
done

if [ -d "$HOME/.cursor" ]; then
  if command -v bun >/dev/null 2>&1; then
    # merge into ~/.cursor/mcp.json, keeping the other servers
    BIN="$bin" NAME="$name" bun -e '
      const fs = require("fs"), f = process.env.HOME + "/.cursor/mcp.json";
      let c = {};
      try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error(f + " is not valid JSON, left untouched"); }
      (c.mcpServers ??= {})[process.env.NAME] = { command: process.env.BIN, args: ["${workspaceFolder}"] };
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
    ' && echo "registered: Cursor (~/.cursor/mcp.json)" && found=1
  else
    echo "Cursor: add to ~/.cursor/mcp.json: \"$name\": { \"command\": \"$bin\", \"args\": [\"\${workspaceFolder}\"] }"
  fi
fi

[ "$found" = 1 ] && echo "start a new session / reload the window to use it" ||
  echo "no MCP client found; see https://github.com/khai-le-codeleap/node-insight-flow#install for manual setup ($bin)"
