# Build context: repository root. The tarball contains both static Linux binaries.
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

# gh v2.103.3 release packages (docs/sandbox-image.md), by architecture and sha256.
FROM scratch AS gh
ADD --checksum=sha256:e3bafef96328d1a67de3a968bdfe1cc2ffd58cf6aba8b5e201356897ed06bb3d https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.deb /amd64.deb
ADD --checksum=sha256:cac3ff84b60b68e64cca69f31f303210c26320361cc3286b773655d4226b7b06 https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_arm64.deb /arm64.deb

# uv 0.13.7, yq v4.54.1 (mikefarah; bookworm's `yq` is another tool) and helm v4.3.2 release binaries, by architecture and sha256.
FROM scratch AS bins
ADD --checksum=sha256:c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83 https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz /uv-amd64.tar.gz
ADD --checksum=sha256:71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc https://github.com/astral-sh/uv/releases/download/0.13.7/uv-aarch64-unknown-linux-gnu.tar.gz /uv-arm64.tar.gz
ADD --checksum=sha256:8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f https://github.com/mikefarah/yq/releases/download/v4.54.1/yq_linux_amd64 /yq-amd64
ADD --checksum=sha256:189088da0c6429ec5178dfaab1a114805f6cab0b61b165ab236efedf1d57a71b https://github.com/mikefarah/yq/releases/download/v4.54.1/yq_linux_arm64 /yq-arm64
ADD --checksum=sha256:d1c0278d46beab79582d7e50f5b3dc206944ba8e577cde618513fd07daa53983 https://get.helm.sh/helm-v4.3.2-linux-amd64.tar.gz /helm-amd64.tar.gz
ADD --checksum=sha256:df31cb61680ef728f82c770e5280dd565617bee6b039d37e85c677288be4bbb0 https://get.helm.sh/helm-v4.3.2-linux-arm64.tar.gz /helm-arm64.tar.gz

# sandboxd executes tools in its own rootfs, so pi-env and the coding tools belong here.
FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11
ARG TARGETARCH
USER root
# Commands run as uid 1000, user `pi` (added below): tools that look the user up (Node `os.userInfo()`, Python `pwd`,
# `whoami`, ssh) need a passwd entry, and HOME must be writable. Caches go to the workspace PVC: they survive a restart
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
    GH_PROMPT_DISABLED=1 \
    HELM_CACHE_HOME=/workspace/.cache/helm \
    HELM_CONFIG_HOME=/workspace/.cache/helm/config \
    HELM_DATA_HOME=/workspace/.cache/helm/data
# Node comes from the pinned Node stage: bookworm's own nodejs is v18.
COPY --from=pi-env /usr/local/bin/node /usr/local/bin/node
COPY --from=pi-env /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=pi-env /usr/local/include/node /usr/local/include/node
COPY --from=gh /${TARGETARCH}.deb /tmp/gh.deb
COPY --from=bins /uv-${TARGETARCH}.tar.gz /tmp/uv.tar.gz
COPY --from=bins --chmod=0755 /yq-${TARGETARCH} /usr/local/bin/yq
COPY --from=bins /helm-${TARGETARCH}.tar.gz /tmp/helm.tar.gz
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates curl jq ripgrep fd-find tree file tini unzip zip xz-utils bzip2 sqlite3 shellcheck \
      build-essential python3 python3-pip python3-venv /tmp/gh.deb \
 && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
 && tar -xzf /tmp/helm.tar.gz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
 && rm -rf /var/lib/apt/lists/* /tmp/gh.deb /tmp/uv.tar.gz /tmp/helm.tar.gz \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && git lfs install --system --skip-repo \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable --install-directory /usr/local/bin pnpm yarn \
 && useradd -U -u 1000 -d /home/pi -M -s /bin/bash pi \
 && test "$(id -u pi):$(id -g pi)" = 1000:1000 \
 && install -d -o 1000 -g 1000 /home/pi
COPY --from=pi-env --chmod=0755 /pi-env /usr/local/bin/pi-env
# sandboxd never reaps orphans: as PID 1 it would keep every zombie for the life of the Pod, and process-group code that
# checks a killed descendant with kill(pid, 0) would see it alive (issue #327). tini reaps them and forwards signals to
# sandboxd. The chart passes only args, so this ENTRYPOINT is what runs.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandboxd"]
USER 1000:1000
