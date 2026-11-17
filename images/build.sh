#!/usr/bin/env bash
# Build context is always the repository root. Nothing is published without --push.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
usage() { echo 'usage: images/build.sh [orchestrator|ingest|sandbox|e2e-driver|all] [--push] [--platform linux/amd64,linux/arm64]' >&2; exit 64; }
image=all
if [[ $# -gt 0 && $1 != --* ]]; then image=$1; shift; fi
case $image in orchestrator|ingest|sandbox|e2e-driver|all) ;; *) usage ;; esac
push=0
platform=linux/amd64,linux/arm64
while [[ $# -gt 0 ]]; do
  case $1 in
    --push) push=1; shift ;;
    --platform) [[ $# -ge 2 && -n $2 ]] || usage; platform=$2; shift 2 ;;
    *) usage ;;
  esac
done
for p in ${platform//,/ }; do
  case $p in linux/amd64|linux/arm64) ;; *) usage ;; esac
done
version=$(node -p "JSON.parse(require('node:fs').readFileSync('$root/package.json', 'utf8')).version")
tag="$version-$(git -C "$root" rev-parse --short HEAD)"
images=("$image")
[[ $image != all ]] || images=(orchestrator ingest sandbox e2e-driver)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
output=()
if [[ $push -eq 1 ]]; then
  output=(--push)
elif [[ $platform != *,* ]]; then
  case $(uname -m) in aarch64|arm64) native=linux/arm64 ;; x86_64|amd64) native=linux/amd64 ;; *) native=unknown ;; esac
  [[ $platform != "$native" ]] || output=(--load)
fi
if [[ ${#output[@]} -eq 0 ]]; then
  # An OCI archive preserves a multi-platform result without publishing it.
  echo 'No push/load: writing OCI archives in the current directory.' >&2
fi
for image in "${images[@]}"; do
  ref="${IMAGE_REPO:+${IMAGE_REPO%/}/}pi-$image:$tag"
  # ${a[@]+...} keeps an empty array legal under set -u in bash 3.2 (macOS).
  action=(${output[@]+"${output[@]}"})
  [[ ${#action[@]} -gt 0 ]] || action=(--output "type=oci,dest=pi-$image-$tag.oci.tar")
  docker buildx build --platform "$platform" -f "$root/images/$image/Dockerfile" \
    -t "$ref" --metadata-file "$work/$image.json" "${action[@]}" "$root"
  digest=$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!m["containerimage.digest"]) process.exit(1); console.log(m["containerimage.digest"])' "$work/$image.json")
  printf 'image: %s\ndigest: %s@%s\n' "$ref" "${ref%:*}" "$digest"
done
