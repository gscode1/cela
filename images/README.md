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
`pi-sandbox-browser`, `pi-egress-proxy`, `pi-e2e-driver` beneath it (default: those local names). Every tag is `<root package version>-<git short sha>`.
Use a clean checkout so the tag identifies its source. The script prints image references and content digests;
use `registry.example.com/team/pi-orchestrator@sha256:…` in your values file (`charts/pi-durable`). Without `--push`, a single native
platform is loaded into Docker; other builds write `pi-<name>-<tag>.oci.tar` in the current directory. No images
are published automatically. Omitting the image target builds `all`. `--platform` accepts `linux/amd64`, `linux/arm64`, or their comma-separated list.

All Dockerfiles take the repository root as context. The egress proxy is a static Go binary (`packages/egress-proxy`, Go pinned in its `go.mod`) on distroless. App builds use the frozen pnpm lockfile and deploy workspace
dependencies, including the vendored adapter/SDK and session-core SQL migrations. The driver includes CLI tools,
suite scripts, Node clients and the sandbox-env Phase 1 test bundle. Containers run as uid/gid 1000; charts
keep the restricted Pod Security controls (ADR 0019).

`pi-sandbox-browser` (`images/sandbox-browser`, ADR 0041) is the sandbox image plus Chromium (Chrome for Testing, installed
by Playwright 1.66.0-alpha-2026-11-18), Playwright CLI 0.1.25 and agent-browser 0.43.0 (release binaries by sha256), and the
loopback forwarder `packages/browser-proxy`. The npm part is pinned by `images/sandbox-browser/package-lock.json`. It is
about 1.6 GB (arm64, uncompressed) and used only with the chart's `sandbox.flavours.browser.enabled`; `hack/kind-up.sh --browser --build` builds it.

The sandbox selects `pi-env` 1.5.2 from its npm tarball by `TARGETARCH`. Verified binary SHA-256 values:

| Architecture | Tarball path | SHA-256 |
| --- | --- | --- |
| amd64 | `package/bin/pi-env-linux-x64/pi-env` | `b730549ce73dbefc2f3e9e90aee6f9f172ae8279d7f84e726b14fffe527f990c` |
| arm64 | `package/bin/pi-env-linux-arm64/pi-env` | `23094f7089e3ab4410431ced346ee50944ae601ea91aa14061573d23d4e3d8c3` |
