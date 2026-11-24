# Build context: repository root. The sandbox image plus a headless Linux desktop (Xvfb, openbox, the AT-SPI accessibility
# bus), Mousepad and LibreOffice Writer driven by agent-desktop through accessibility (xdotool and scrot as the fallback),
# Google Chrome for web pages read by desktop-web, and the loopback forwarder that gives Chrome the session's egress token.
# The pi-env stage is the same as images/sandbox/Dockerfile (a test keeps them equal).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS pi-env
ARG TARGETARCH
WORKDIR /tmp/pi-env
ADD --checksum=sha256:e3f9e6b8164460b43730c7b72d9d436bd09958ac4e6d237af356e9bd6d5d776f https://registry.npmjs.org/@earendil-works/pi-env/-/pi-env-1.6.0.tgz ./
RUN tar xzf pi-env-1.6.0.tgz \
 && case "$TARGETARCH" in \
      amd64) arch=x64; sum=c28dc21e95a8895ad47f721cb57c4bce3d6c2ba8c036f528b72c54b7813a94ca ;; \
      arm64) arch=arm64; sum=020022f2b0f8198b691f7c73333bb04310dc35e4a49be3109778765c6bec795e ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && cp "package/bin/pi-env-linux-$arch/pi-env" /pi-env \
 && echo "$sum  /pi-env" | sha256sum -c -

# The forwarder is a workspace package with no dependencies: only its compiled output is copied (as in the browser image).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS forwarder
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @cela/browser-proxy... \
 && pnpm --filter @cela/browser-proxy build

# agent-desktop v1.3.1 release archives (glibc builds), by architecture and sha256.
FROM scratch AS agent-desktop-archive
ADD --checksum=sha256:ca77b6b75034eeb12e537dd8c0a4f2a3424119253f38b7e6bd79ba0d2fef1264 https://github.com/vercel-labs/agent-desktop/releases/download/v1.3.1/agent-desktop-v1.3.1-x86_64-unknown-linux-gnu.tar.gz /amd64
ADD --checksum=sha256:438990a703fbeb19775596c341c3701435e80adbfa1b2f64b82ff17567d5573b https://github.com/vercel-labs/agent-desktop/releases/download/v1.3.1/agent-desktop-v1.3.1-aarch64-unknown-linux-gnu.tar.gz /arm64

# The archive holds the binary and its X11 clipboard helper, which must sit beside it.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS agent-desktop
ARG TARGETARCH
COPY --from=agent-desktop-archive /${TARGETARCH} /tmp/agent-desktop.tar.gz
RUN mkdir /out && tar -xzf /tmp/agent-desktop.tar.gz -C /out agent-desktop agent-desktop-linux-clipboard-owner

FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11@sha256:c4719d5dd70a29b6c0ce9f90a2bf56c52938b0467684510b0fd78e4a3a775fe9
ARG TARGETARCH
USER root
# Google serves only its current Chrome, so this pin expires within weeks. .github/workflows/chrome-bump.yml opens the PR
# that moves it (hack/chrome-bump.mjs); a build against an expired pin fails with the message below.
ARG CHROME_VERSION=158.0.8127.88-1
# Commands run as uid 1000, user `pi` (added below): dbus and the toolkits look the user up and need a passwd entry, and HOME
# must be writable (images/sandbox/Dockerfile, issue #324). Caches go to the workspace volume, not the root filesystem.
ENV HOME=/home/pi \
    XDG_CACHE_HOME=/workspace/.cache
COPY --from=forwarder /usr/local/bin/node /usr/local/bin/node
ADD https://dl.google.com/linux/linux_signing_key.pub /tmp/google-linux-signing-key.pub
# Desktop: X server, window manager, session bus, the accessibility bus with its GTK bridge, input and capture tools.
# xclip and jq serve desktop-page and the agent's own filters, python3-pil desktop-shot; `python` is a link to python3 (websockify's dependency).
# Apps: Mousepad (GTK), LibreOffice Writer with the GTK3 plugin that exposes its tree, and Google Chrome for web pages through
# desktop-web. Chrome, not Debian's Chromium: only Google's build reports the "Google Chrome" brand in
# navigator.userAgentData, which detectors check (rebrowser's useragent test). It comes from Google's signed apt repository
# (stable channel, amd64 and arm64) at the version in CHROME_VERSION, whose key is pinned by fingerprint below.
# Lab live view (ADR 0065): x11vnc (view-only) and noVNC behind websockify, both started by agent-desktop-run on loopback.
# The repository is used for this one install: its source file is removed afterwards (and Chrome's package would re-add one),
# so a later `apt-get update` in this image does not reach Google. A new Chrome comes with a rebuilt image. gnupg is only there
# to check and convert the key (HOME does not exist yet at this point, hence the temporary GNUPGHOME).
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini procps gnupg \
    xvfb openbox dbus dbus-x11 x11-utils at-spi2-core libatk-bridge2.0-0 xdotool xclip scrot jq python3-pil \
    mousepad libreoffice-writer libreoffice-gtk3 fonts-dejavu-core fonts-liberation \
    x11vnc novnc websockify \
 && export GNUPGHOME="$(mktemp -d)" \
 && fpr=$(gpg --show-keys --with-colons /tmp/google-linux-signing-key.pub | awk -F: '/^fpr:/ {print $10; exit}') \
 && test "$fpr" = EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796 \
 && install -d -m 0755 /etc/apt/keyrings \
 && gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg /tmp/google-linux-signing-key.pub \
 && echo "deb [arch=$TARGETARCH signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    >/etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && { apt-cache madison google-chrome-stable | awk -v v="$CHROME_VERSION" '$3 == v {found = 1} END {exit !found}' \
      || { echo "CHROME_VERSION=$CHROME_VERSION is no longer served by Google's repository (it keeps only the current build): run hack/chrome-bump.mjs or the chrome-bump workflow to move the pin" >&2; exit 1; }; } \
 && apt-get install -y --no-install-recommends "google-chrome-stable=$CHROME_VERSION" \
 && rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/* /tmp/* \
 && test -x /usr/bin/python3 && ln -s python3 /usr/bin/python \
 && useradd -U -u 1000 -d /home/pi -M -s /bin/bash pi \
 && test "$(id -u pi):$(id -g pi)" = 1000:1000 \
 && install -d -o 1000 -g 1000 /home/pi \
 && install -d -m 1777 /tmp/.X11-unix
COPY --from=pi-env --chmod=0755 /pi-env /usr/local/bin/pi-env
COPY --from=agent-desktop --chmod=0755 /out/agent-desktop /out/agent-desktop-linux-clipboard-owner /usr/local/bin/
COPY --from=forwarder /src/packages/browser-proxy/dist /opt/browser-proxy/dist
COPY --from=forwarder /src/packages/browser-proxy/package.json /opt/browser-proxy/package.json
COPY images/sandbox-desktop/files/chrome-policy.json /etc/opt/chrome/policies/managed/pi-desktop.json
COPY --chmod=0755 images/sandbox-desktop/files/agent-desktop-run /usr/local/bin/agent-desktop-run
COPY --chmod=0755 images/sandbox-desktop/files/desktop-launch /usr/local/bin/desktop-launch
COPY --chmod=0755 images/sandbox-desktop/files/desktop-find /usr/local/bin/desktop-find
COPY --chmod=0755 images/sandbox-desktop/files/desktop-page /usr/local/bin/desktop-page
COPY --chmod=0644 images/sandbox-desktop/files/desktop-lib.cjs /usr/local/bin/desktop-lib.cjs
COPY --chmod=0755 images/sandbox-desktop/files/desktop-web /usr/local/bin/desktop-web
COPY --chmod=0644 images/sandbox-desktop/files/cdp-lib.cjs /usr/local/bin/cdp-lib.cjs
COPY --chmod=0755 images/sandbox-desktop/files/desktop-shot /usr/local/bin/desktop-shot
COPY images/sandbox-desktop/files/novnc-index.html /usr/share/novnc/index.html
COPY images/sandbox-desktop/files/DESKTOP.md /usr/local/share/pi-desktop/DESKTOP.md
# PID 1 must reap orphans; sandboxd does not (images/sandbox/Dockerfile, issue #327).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandboxd"]
USER 1000:1000
