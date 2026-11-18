# The egress proxy (epic #50, ADR 0012 and 0035): a static Go binary on distroless. Build context is the repository root,
# like the other images (images/build.sh egress-proxy). Keep the Go version equal to go.mod's toolchain line (ADR 0012).
FROM --platform=$BUILDPLATFORM golang:1.27.3 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY packages/egress-proxy/go.mod packages/egress-proxy/go.sum ./
RUN go mod download
COPY packages/egress-proxy/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/egress-proxy ./cmd/egress-proxy

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/egress-proxy /egress-proxy
# The chart runs the pod as uid/gid 1000 like the other images; the binary needs no user of its own.
USER 1000:1000
ENTRYPOINT ["/egress-proxy"]
