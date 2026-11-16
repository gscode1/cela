# Topology A: the runtime container is sandboxd; pi-env must live in this image
# because sandboxd runs commands in its own rootfs.
FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11

# pi-env 1.5.2 linux-arm64 static binary, taken from the npm tarball by build.sh
# (which verifies this digest before the build).
ARG PI_ENV_SHA256=23094f7089e3ab4410431ced346ee50944ae601ea91aa14061573d23d4e3d8c3
COPY --chmod=0755 pi-env /usr/local/bin/pi-env
USER root
RUN echo "${PI_ENV_SHA256}  /usr/local/bin/pi-env" | sha256sum -c -
# Phase 4c: repo sessions clone and push with git through the OneCLI gateway, and trust its CA on top of the system roots.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
USER 1000
