# Build context: repository root. The tarball contains both static Linux binaries.
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

# gh v2.103.3 release packages (docs/sandbox-image.md), by architecture and sha256.
FROM scratch AS gh
ADD --checksum=sha256:e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.deb /amd64.deb
ADD --checksum=sha256:cac3ff84b60b68e64cca69f31f303210c26320361cc3286b773655d4226b7b06 https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_arm64.deb /arm64.deb

# sandboxd executes tools in its own rootfs, so pi-env and the coding tools belong here.
FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11
ARG TARGETARCH
USER root
# uid 1000 has no passwd entry, so HOME would be the unwritable `/`. Caches go to the workspace PVC: they survive a restart
# and do not count against the sandbox's small ephemeral-storage limit. node-gyp takes the headers copied below instead of
# downloading them from nodejs.org, which no egress rule set allows.
ENV HOME=/home/pi \
    XDG_CACHE_HOME=/workspace/.cache \
    npm_config_cache=/workspace/.cache/npm \
    npm_config_nodedir=/usr/local \
    npm_config_update_notifier=false \
    COREPACK_HOME=/workspace/.cache/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GH_PROMPT_DISABLED=1
# Node comes from the pinned Node stage: bookworm's own nodejs is v18.
COPY --from=pi-env /usr/local/bin/node /usr/local/bin/node
COPY --from=pi-env /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=pi-env /usr/local/include/node /usr/local/include/node
COPY --from=gh /${TARGETARCH}.deb /tmp/gh.deb
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq unzip build-essential python3 python3-pip python3-venv /tmp/gh.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/gh.deb \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable --install-directory /usr/local/bin pnpm yarn \
 && install -d -o 1000 -g 1000 /home/pi
COPY --from=pi-env --chmod=0755 /pi-env /usr/local/bin/pi-env
USER 1000:1000
