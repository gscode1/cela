#!/usr/bin/env bash
# Builds the two release assets of the MCP adapter (ADR 0051) into <out-dir>:
#   cela-mcp-<version>.tgz    npm pack of packages/mcp (files: dist; runtime deps from package.json only)
#   cela-mcp-<version>.mcpb   MCP Bundle for Claude Desktop (mcpb pack of dist + a flat production node_modules)
# Run from anywhere; needs pnpm on PATH and `pnpm install` done (it provides the pinned mcpb CLI).
set -euo pipefail

out=${1:?usage: release-build.sh <out-dir>}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
version=$(node -p 'require(process.argv[1]).version' "$root/packages/mcp/package.json")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cd "$root"
pnpm --filter "@cela/mcp..." build
pnpm --filter @cela/mcp pack --pack-destination "$out"

# A flat (hoisted) production install from the workspace lockfile: no symlinks, and no devDependency such as
# @cela/session-core. `files: ["dist"]` keeps sources and tests out of the stage.
pnpm --filter @cela/mcp --config.node-linker=hoisted deploy --prod "$stage/bundle"
cp packages/mcp/manifest.json "$stage/bundle/manifest.json"
rm -rf "$stage/bundle/node_modules/.pnpm" "$stage/bundle/node_modules/.modules.yaml" \
  "$stage/bundle/node_modules/.pnpm-workspace-state-v1.json" "$stage/bundle/pnpm-lock.yaml" "$stage/bundle/pnpm-workspace.yaml"

pnpm --filter @cela/mcp exec mcpb validate "$stage/bundle"
pnpm --filter @cela/mcp exec mcpb pack "$stage/bundle" "$out/cela-mcp-$version.mcpb"
ls -l "$out/cela-mcp-$version.tgz" "$out/cela-mcp-$version.mcpb"
