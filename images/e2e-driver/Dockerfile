# Build context: repository root. Deploy keeps workspace dependencies, the vendored SDK and SQL migrations together.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@cela/sandbox-env..." build \
 && pnpm --filter @cela/sandbox-env deploy --prod=false /out

# kubectl is a static binary; use the same version as the existing driver.
FROM docker.io/alpine/k8s:1.36.2@sha256:44ef4942e171939b9c665a4a84beb80e2dcdb9a24330d4651cfdfd2e9deecc47 AS tools

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
# Suites need the CLI tools as well as Node for their HTTP/SSE clients.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl jq openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/bin/kubectl /usr/local/bin/kubectl
COPY --from=build --chown=1000:1000 /out /opt/phase1
COPY tests/e2e /driver/tests/e2e
COPY hack/gen-api-secret.sh /driver/hack/gen-api-secret.sh
# The browser suite seeds the browser profile with the script and the skills of the browser image.
COPY hack/seed-browser-profile.mjs /driver/hack/seed-browser-profile.mjs
COPY images/sandbox-browser/skills /driver/images/sandbox-browser/skills
USER 1000:1000
WORKDIR /driver
CMD ["bash"]
