# Egress proxy (issue #51). Build context: packages/egress-proxy.
#   docker buildx build --platform linux/arm64,linux/amd64 -f images/egress-proxy/Dockerfile packages/egress-proxy
# Not built or pushed by the spike. Keep the Go version equal to go.mod's toolchain line (ADR 0011).
FROM --platform=$BUILDPLATFORM golang:1.27.3 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/egress-proxy ./cmd/egress-proxy

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/egress-proxy /egress-proxy
USER nonroot
ENTRYPOINT ["/egress-proxy"]
