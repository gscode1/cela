# Build context: repository root. Deploy keeps workspace dependencies, the vendored SDK and SQL migrations together.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# The public live view's page is the repo's viewer.* beside the pinned noVNC modules (core/ is browser-loadable ESM that
# imports vendor/pako by a relative path); `-L` because pnpm's deployed node_modules are symlinks. Ingest serves it only
# when PI_LIVE_VIEW_DIR names it (the chart sets /app/live-view with liveView.enabled).
# The console is a static bundle and not a dependency of ingest, so it is built and copied on its own. Ingest serves it
# only when PI_CONSOLE_DIR names it (the chart sets /app/console with console.enabled).
RUN pnpm --filter "@cela/ingest..." build \
 && pnpm --filter @cela/admin-ui build \
 && pnpm --filter @cela/ingest deploy --prod /out \
 && mkdir -p /live-view/novnc \
 && cp -L /src/packages/ingest/live-view/viewer.* /live-view/ \
 && cp -rL /out/node_modules/@novnc/novnc/core /out/node_modules/@novnc/novnc/vendor /live-view/novnc/

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
WORKDIR /app
COPY --from=build --chown=1000:1000 /out ./
COPY --from=build --chown=1000:1000 /src/packages/admin-ui/dist ./console
COPY --from=build --chown=1000:1000 /live-view ./live-view
USER 1000:1000
CMD ["node", "dist/main.js"]
