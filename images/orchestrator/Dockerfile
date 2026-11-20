# Build context: repository root. Deploy keeps workspace dependencies, the vendored SDK and SQL migrations together.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@cela/orchestrator..." build \
 && pnpm --filter @cela/orchestrator deploy --prod /out

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
WORKDIR /app
COPY --from=build --chown=1000:1000 /out ./
USER 1000:1000
CMD ["node", "dist/main.js"]
