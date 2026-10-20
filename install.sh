#!/bin/sh
# Install the latest node-insight-flow release into ~/.node-insight-flow and register it with Claude Code.
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

if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user node-insight-flow >/dev/null 2>&1 || true
  claude mcp add --scope user node-insight-flow -- "$bin"
  echo "registered with Claude Code (user scope); start a new session to use it"
else
  echo "register it with: claude mcp add --scope user node-insight-flow -- $bin"
fi
