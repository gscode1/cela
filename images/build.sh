#!/usr/bin/env bash
# Build context is always the repository root. Nothing is published without --push.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
usage() { echo 'usage: images/build.sh [orchestrator|ingest|sandbox|sandbox-browser|sandbox-desktop|egress-proxy|e2e-driver|all] [--push | --push-by-digest] [--platform linux/amd64,linux/arm64]' >&2; exit 64; }
image=all
if [[ $# -gt 0 && $1 != --* ]]; then image=$1; shift; fi
case $image in orchestrator|ingest|sandbox|sandbox-browser|sandbox-desktop|egress-proxy|e2e-driver|all) ;; *) usage ;; esac
push=0
platform=linux/amd64,linux/arm64
while [[ $# -gt 0 ]]; do
  case $1 in
    --push) push=1; shift ;;
    # Untagged, for CI: one native runner per platform pushes its image by digest, and a later step joins the digests
    # under the tag with `docker buildx imagetools create` (.github/workflows/images.yml).
    --push-by-digest) push=2; shift ;;
    --platform) [[ $# -ge 2 && -n $2 ]] || usage; platform=$2; shift 2 ;;
    *) usage ;;
  esac
done
for p in ${platform//,/ }; do
  case $p in linux/amd64|linux/arm64) ;; *) usage ;; esac
done
[[ $push -ne 2 || -n ${IMAGE_REPO:-} ]] || { echo 'build.sh: --push-by-digest needs IMAGE_REPO' >&2; exit 64; }
# BUILD_CACHE_REPO (a registry prefix like IMAGE_REPO) reads the layer cache <prefix>/pi-<name>:cache-<arch> for each
# platform; BUILD_CACHE_WRITE=1 also writes it, for a single platform only so that per-architecture runners do not
# overwrite each other's cache. Without them nothing is cached between runs (CI runners start empty).
if [[ -n ${BUILD_CACHE_WRITE:-} && ( -z ${BUILD_CACHE_REPO:-} || $platform == *,* ) ]]; then
  echo 'build.sh: BUILD_CACHE_WRITE needs BUILD_CACHE_REPO and a single --platform' >&2
  exit 64
fi
version=$(node -p "JSON.parse(require('node:fs').readFileSync('$root/package.json', 'utf8')).version")
tag="$version-$(git -C "$root" rev-parse --short HEAD)"
images=("$image")
[[ $image != all ]] || images=(orchestrator ingest sandbox sandbox-browser sandbox-desktop egress-proxy e2e-driver)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
output=()
if [[ $push -eq 1 ]]; then
  output=(--push)
elif [[ $push -eq 2 ]]; then
  output=(--push-by-digest)
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
  tags=(-t "$ref")
  if [[ ${action[0]} == --push-by-digest ]]; then
    action=(--output "type=image,name=${ref%:*},push-by-digest=true,name-canonical=true,push=true")
    tags=()
  fi
  cache=()
  if [[ -n ${BUILD_CACHE_REPO:-} ]]; then
    for p in ${platform//,/ }; do
      cache+=(--cache-from "type=registry,ref=${BUILD_CACHE_REPO%/}/pi-$image:cache-${p#linux/}")
    done
    # mode=max keeps the layers of every stage (the apt and pnpm stages are the expensive ones, not only the final image).
    [[ -z ${BUILD_CACHE_WRITE:-} ]] ||
      cache+=(--cache-to "type=registry,ref=${BUILD_CACHE_REPO%/}/pi-$image:cache-${platform#linux/},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true")
  fi
  # IMAGE_SOURCE links a registry package to its repository (ghcr.io then inherits the repository's visibility).
  label=()
  [[ -z ${IMAGE_SOURCE:-} ]] || label=(--label "org.opencontainers.image.source=$IMAGE_SOURCE")
  docker buildx build --platform "$platform" -f "$root/images/$image/Dockerfile" \
    ${tags[@]+"${tags[@]}"} --metadata-file "$work/$image.json" ${label[@]+"${label[@]}"} \
    ${cache[@]+"${cache[@]}"} "${action[@]}" "$root"
  digest=$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (!m["containerimage.digest"]) process.exit(1); console.log(m["containerimage.digest"])' "$work/$image.json")
  printf 'image: %s\ndigest: %s@%s\n' "$ref" "${ref%:*}" "$digest"
done
