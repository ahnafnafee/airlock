# syntax=docker/dockerfile:1.7

# Keep the builder aligned with go.mod. The index digest pins the official
# multi-platform image while still allowing both linux/amd64 and linux/arm64.
ARG GO_IMAGE=golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd
FROM ${GO_IMAGE} AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY *.go ./
COPY web ./web

ARG TARGETOS=linux
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/airlock . && \
    install -d -m 0700 -o 65532 -g 65532 /out/data

# Distroless supplies CA roots for the Tailscale control plane and Web Push,
# but no shell or package manager. Airlock runs as the image's nonroot user.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a

COPY --from=build --chown=65532:65532 /out/airlock /airlock
COPY --from=build --chown=65532:65532 --chmod=0700 /out/data /var/lib/airlock

USER 65532:65532
WORKDIR /var/lib/airlock
ENTRYPOINT ["/airlock"]
CMD ["--tailscale-mode=embedded", "--data=/var/lib/airlock", "--require-approval"]
