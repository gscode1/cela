# Build images

From the repository root (Docker buildx and Node 22.19+ required):

```sh
images/build.sh all                              # amd64 + arm64 OCI archives; no publication
images/build.sh all --platform linux/arm64       # --load on a native arm64 host
IMAGE_REPO=registry.example.com/team images/build.sh all --push
```

CI (`.github/workflows/images.yml`) runs the same script for every push to `main` and every pull request of this
repository and publishes to `ghcr.io/<owner>/pi-*:<version>-<short sha>`; the job summary lists the digests.

`IMAGE_REPO` is a registry/repository **prefix**: images are named `pi-orchestrator`, `pi-ingest`, `pi-sandbox`,
`pi-sandbox-browser`, `pi-sandbox-desktop`, `pi-egress-proxy`, `pi-e2e-driver` beneath it (default: those local names). Every tag is `<root package version>-<git short sha>`.
Use a clean checkout so the tag identifies its source. The script prints image references and content digests;
use `registry.example.com/team/pi-orchestrator@sha256:…` in your values file (`charts/cela`). Without `--push`, a single native
platform is loaded into Docker; other builds write `pi-<name>-<tag>.oci.tar` in the current directory. No images
are published automatically. Omitting the image target builds `all`. `--platform` accepts `linux/amd64`, `linux/arm64`, or their comma-separated list.

Base images (Node, Go, distroless and sandboxd) are pinned as `tag@sha256:…` using multi-arch index digests so the same
commit cannot silently pick up a changed base tag. When updating a base, resolve its index with
`docker buildx imagetools inspect <image>:<tag>` and retain both linux/amd64 and linux/arm64 support.

All Dockerfiles take the repository root as context. The egress proxy is a static Go binary (`packages/egress-proxy`, Go pinned in its `go.mod`) on distroless. App builds use the frozen pnpm lockfile and deploy workspace
dependencies, including the vendored adapter/SDK and session-core SQL migrations. The driver includes CLI tools,
suite scripts, Node clients and the sandbox-env Phase 1 test bundle. Containers run as uid/gid 1000; charts
keep the restricted Pod Security controls (ADR 0019).

`pi-sandbox` (`images/sandbox`, ADR 0048) is sandboxd plus `pi-env`, git, Node 22 (npm, corepack), Python 3 (pip, venv),
build-essential, curl, jq, unzip and `gh` 2.103.3 (release `.deb` by sha256); the list is in
[docs/sandbox-image.md](../docs/sandbox-image.md). About 1 GB (arm64, uncompressed).

`pi-sandbox-browser` (`images/sandbox-browser`, ADR 0041) is the sandbox image plus Chromium (installed by Patchright 1.64.3,
ADR 0046), Patchright and agent-browser 0.43.0 (release binaries by sha256), and the
loopback forwarder `packages/browser-proxy`. The npm part is pinned by `images/sandbox-browser/package-lock.json`. It is
about 1.6 GB (arm64, uncompressed) and needed by the chart's `sandbox.flavours.browser.enabled` (the default; `false` skips it); `hack/kind-up.sh --build` builds it unless `--no-browser`.

`pi-sandbox-desktop` (`images/sandbox-desktop`, ADR 0065) is the sandbox base plus a headless desktop (Xvfb, openbox, the
AT-SPI accessibility bus), Mousepad, LibreOffice Writer, Firefox ESR, xdotool and scrot, agent-desktop 1.3.1 (release
archives by sha256 for amd64 and arm64) with the `agent-desktop-run` and `desktop-launch` wrappers, the two skills in
`images/sandbox-desktop/skills`, and the loopback forwarder `packages/browser-proxy` for Firefox's egress proxy. Debian
packages come from the pinned base's bookworm repositories, unpinned. It is about 1.9 GB (arm64, uncompressed) and needed
by the chart's `sandbox.flavours.desktop.enabled` (default false).

The sandbox selects `pi-env` 1.6.0 from its npm tarball by `TARGETARCH`. Verified binary SHA-256 values:

| Architecture | Tarball path | SHA-256 |
| --- | --- | --- |
| amd64 | `package/bin/pi-env-linux-x64/pi-env` | `c28dc21e95a8895ad47f721cb57c4bce3d6c2ba8c036f528b72c54b7813a94ca` |
| arm64 | `package/bin/pi-env-linux-arm64/pi-env` | `020022f2b0f8198b691f7c73333bb04310dc35e4a49be3109778765c6bec795e` |
