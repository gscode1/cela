#!/usr/bin/env bash
# Build and push the sandbox image (sandboxd + pi-env), linux/arm64.
# Usage: images/sandbox/build.sh [--no-push]
set -euo pipefail

PI_ENV_VERSION=1.5.2
PI_ENV_SHA256=23094f7089e3ab4410431ced346ee50944ae601ea91aa14061573d23d4e3d8c3  # bin/pi-env-linux-arm64/pi-env
REPO=docker.io/gsimage/pi-sandbox
# Bump when the Dockerfile changes without a pi-env bump. r2: git and ca-certificates (Phase 4c).
IMAGE_REV=2

here=$(cd "$(dirname "$0")" && pwd)
sha=$(git -C "$here" rev-parse --short HEAD)
tag="${PI_ENV_VERSION}-r${IMAGE_REV}-${sha}"

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
(cd "$ctx" && npm pack "@earendil-works/pi-env@${PI_ENV_VERSION}" --silent >/dev/null \
  && tar xzf ./*.tgz package/bin/pi-env-linux-arm64/pi-env)
cp "$ctx/package/bin/pi-env-linux-arm64/pi-env" "$ctx/pi-env"
echo "${PI_ENV_SHA256}  $ctx/pi-env" | shasum -a 256 -c -
cp "$here/Dockerfile" "$ctx/Dockerfile"

action=--push
[ "${1:-}" = "--no-push" ] && action=--load
docker buildx build --platform linux/arm64 --build-arg "PI_ENV_SHA256=${PI_ENV_SHA256}" \
  -t "${REPO}:${tag}" "$action" "$ctx"
echo "image: ${REPO}:${tag}"
