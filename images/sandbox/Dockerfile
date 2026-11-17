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

# sandboxd executes tools in its own rootfs, so pi-env and git belong here.
FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11
USER root
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=pi-env --chmod=0755 /pi-env /usr/local/bin/pi-env
USER 1000:1000
