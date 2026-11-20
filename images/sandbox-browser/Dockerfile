# Build context: repository root. The sandbox image plus one Chromium, Patchright and agent-browser, both driving that
# Chromium, and the loopback forwarder that gives it the session's egress token (docs/decisions/0041-browser-sandbox.md,
# 0046-patchright-browser.md).
# The pi-env stage is the same as images/sandbox/Dockerfile (a test keeps them equal).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS pi-env
ARG TARGETARCH
WORKDIR /tmp/pi-env
ADD --checksum=sha256:abdc7b5661342acc0b5ba2fbc52b0c63c82a472185b2c82d13335c4b066f2085 https://registry.npmjs.org/@earendil-works/pi-env/-/pi-env-1.5.2.tgz ./
RUN tar xzf pi-env-1.5.2.tgz \
 && case "$TARGETARCH" in \
      amd64) arch=x64; sum=b730549ce73dbefc2f3e9e90aee6f9f172ae8279d7f84e726b14fffe527f990c ;; \
      arm64) arch=arm64; sum=23094f7089e3ab4410431ced346ee50944ae601ea91aa14061573d23d4e3d8c3 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && cp "package/bin/pi-env-linux-$arch/pi-env" /pi-env \
 && echo "$sum  /pi-env" | sha256sum -c -

# The forwarder is a workspace package with no dependencies: only its compiled output is copied.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS forwarder
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @cela/browser-proxy... \
 && pnpm --filter @cela/browser-proxy build

# Exact versions from the lockfile (patchright 1.64.3 pins patchright-core 1.64.3, whose Chromium is the one both tools
# drive).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS tools
WORKDIR /opt/browser-tools
COPY images/sandbox-browser/package.json images/sandbox-browser/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# agent-browser v0.43.0 release binaries (glibc builds), by architecture and sha256.
FROM scratch AS agent-browser
ADD --checksum=sha256:8e69c9fb662514c9cf36e4911e94e913742ba066e55102486350e049dd847612 https://github.com/vercel-labs/agent-browser/releases/download/v0.43.0/agent-browser-linux-x64 /amd64
ADD --checksum=sha256:34be55c2b92d8d199fb9d1d62a905ee5b6ac5b1f3e8c24e5b20597f370d905e5 https://github.com/vercel-labs/agent-browser/releases/download/v0.43.0/agent-browser-linux-arm64 /arm64

FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11
ARG TARGETARCH
USER root
# Commands run as uid 1000, user `pi` (added below): tools that look the user up need a passwd entry, and HOME must be
# writable (images/sandbox/Dockerfile, issue #324).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    HOME=/home/pi
COPY --from=tools /opt/browser-tools /opt/browser-tools
COPY --from=tools /usr/local/bin/node /usr/local/bin/node
# Chromium's system libraries come from Patchright's own list (Playwright's, for this distribution); the browser is the one
# build of Chromium that Patchright's version pins, for both architectures. No headless shell: both tools drive the full
# browser.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && node /opt/browser-tools/node_modules/patchright/cli.js install-deps chromium \
 && node /opt/browser-tools/node_modules/patchright/cli.js install --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/* \
 && chmod -R a+rX /opt/ms-playwright \
 && ln -s "$(find /opt/ms-playwright -maxdepth 3 -type f -name chrome | head -n 1)" /usr/local/bin/pi-chromium \
 && useradd -U -u 1000 -d /home/pi -M -s /bin/bash pi \
 && test "$(id -u pi):$(id -g pi)" = 1000:1000 \
 && install -d -o 1000 -g 1000 /home/pi
COPY --from=pi-env --chmod=0755 /pi-env /usr/local/bin/pi-env
COPY --from=agent-browser --chmod=0755 /${TARGETARCH} /opt/agent-browser/agent-browser
COPY --from=forwarder /src/packages/browser-proxy/dist /opt/browser-proxy/dist
COPY --from=forwarder /src/packages/browser-proxy/package.json /opt/browser-proxy/package.json
# Chrome for Testing (what Patchright installs) reads /etc/opt/chrome_for_testing; a plain Chromium reads /etc/chromium.
COPY images/sandbox-browser/files/chromium-policy.json /etc/opt/chrome_for_testing/policies/managed/pi-browser.json
COPY images/sandbox-browser/files/chromium-policy.json /etc/chromium/policies/managed/pi-browser.json
COPY --chmod=0755 images/sandbox-browser/files/pi-browser /usr/local/bin/pi-browser
COPY --chmod=0755 images/sandbox-browser/files/patchright-run /usr/local/bin/patchright-run
COPY --chmod=0755 images/sandbox-browser/files/agent-browser /usr/local/bin/agent-browser
COPY images/sandbox-browser/files/BROWSER.md /usr/local/share/pi-browser/BROWSER.md
# PID 1 must reap orphans; sandboxd does not (images/sandbox/Dockerfile, issue #327).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandboxd"]
USER 1000:1000
