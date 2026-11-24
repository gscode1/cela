# Build context: repository root. The sandbox image plus a headless Linux desktop (Xvfb, openbox, the AT-SPI accessibility
# bus), three apps (Mousepad, LibreOffice Writer, Firefox ESR), agent-desktop that drives them through accessibility, xdotool
# and scrot as the fallback, and the loopback forwarder that gives Firefox the session's egress token.
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
# Commands run as uid 1000, user `pi` (added below): dbus and the toolkits look the user up and need a passwd entry, and HOME
# must be writable (images/sandbox/Dockerfile, issue #324). Caches go to the workspace volume, not the root filesystem.
ENV HOME=/home/pi \
    XDG_CACHE_HOME=/workspace/.cache
COPY --from=forwarder /usr/local/bin/node /usr/local/bin/node
# Desktop: X server, window manager, session bus, the accessibility bus with its GTK bridge, input and capture tools.
# xclip and jq serve desktop-url, desktop-page and the agent's own filters, python3-pil desktop-shot; `python` is a link to python3 (websockify's dependency).
# Apps: Mousepad (GTK), LibreOffice Writer with the GTK3 plugin that exposes its tree, Firefox ESR, and Chromium for web pages
# through desktop-web (Debian's build, security updates with the distribution).
# Lab live view (ADR 0065): x11vnc (view-only) and noVNC behind websockify, both started by agent-desktop-run on loopback.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini procps \
    xvfb openbox dbus dbus-x11 x11-utils at-spi2-core libatk-bridge2.0-0 xdotool xclip scrot jq python3-pil \
    mousepad libreoffice-writer libreoffice-gtk3 firefox-esr chromium fonts-dejavu-core fonts-liberation \
    x11vnc novnc websockify \
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
COPY images/sandbox-desktop/files/firefox-policies.json /usr/lib/firefox-esr/distribution/policies.json
COPY images/sandbox-desktop/files/chromium-policy.json /etc/chromium/policies/managed/pi-desktop.json
# "I still don't care about cookies" 1.1.9 (GPL-3.0-only, AMO), force-installed by the policy file: it accepts or hides cookie
# consent banners on any site, from rules its maintainers keep, so the agent does not spend clicks and screenshots on them.
# The file goes into distribution/, which the policy COPY above already made: a directory ADD creates is mode 0700 root, and
# Firefox, running as pi, could not read the extension from it.
ADD --checksum=sha256:42922f61cfc53e2103e492ddbe5736caf503d9dad4a88690efc4c64dac10d5c7 --chmod=0644 \
  https://addons.mozilla.org/firefox/downloads/file/4637154/istilldontcareaboutcookies-1.1.9.xpi \
  /usr/lib/firefox-esr/distribution/idcac-pub@guus.ninja.xpi
COPY --chmod=0755 images/sandbox-desktop/files/agent-desktop-run /usr/local/bin/agent-desktop-run
COPY --chmod=0755 images/sandbox-desktop/files/desktop-launch /usr/local/bin/desktop-launch
COPY --chmod=0755 images/sandbox-desktop/files/desktop-find /usr/local/bin/desktop-find
COPY --chmod=0755 images/sandbox-desktop/files/desktop-url /usr/local/bin/desktop-url
COPY --chmod=0755 images/sandbox-desktop/files/desktop-page /usr/local/bin/desktop-page
COPY --chmod=0755 images/sandbox-desktop/files/desktop-click /usr/local/bin/desktop-click
COPY --chmod=0755 images/sandbox-desktop/files/desktop-open /usr/local/bin/desktop-open
COPY --chmod=0644 images/sandbox-desktop/files/desktop-lib.cjs /usr/local/bin/desktop-lib.cjs
COPY --chmod=0755 images/sandbox-desktop/files/desktop-web /usr/local/bin/desktop-web
COPY --chmod=0644 images/sandbox-desktop/files/cdp-lib.cjs /usr/local/bin/cdp-lib.cjs
# desktop-text is desktop-page's first name.
RUN ln -s desktop-page /usr/local/bin/desktop-text
COPY --chmod=0755 images/sandbox-desktop/files/desktop-shot /usr/local/bin/desktop-shot
COPY images/sandbox-desktop/files/novnc-index.html /usr/share/novnc/index.html
COPY images/sandbox-desktop/files/DESKTOP.md /usr/local/share/pi-desktop/DESKTOP.md
# PID 1 must reap orphans; sandboxd does not (images/sandbox/Dockerfile, issue #327).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandboxd"]
USER 1000:1000
