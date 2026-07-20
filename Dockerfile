FROM node:22-bookworm-slim AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run web:build

FROM rust:1.88-bookworm AS server-build
WORKDIR /build
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs ./src-tauri/
RUN mkdir -p src-tauri/src/bin \
    && printf 'pub fn placeholder() {}\n' > src-tauri/src/lib.rs \
    && printf 'fn main() {}\n' > src-tauri/src/bin/dienstenlezer-server.rs \
    && cargo build --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --features server --bin dienstenlezer-server
COPY src-tauri/src ./src-tauri/src
RUN cargo build --locked --release --manifest-path src-tauri/Cargo.toml --no-default-features --features server --bin dienstenlezer-server

FROM debian:bookworm-slim
ARG BUILD_VERSION=dev
ARG BUILD_ARCH=unknown
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data
WORKDIR /app
COPY --from=server-build /build/src-tauri/target/release/dienstenlezer-server /app/dienstenlezer-server
COPY --from=web-build /build/dist /app/dist
ENV DIENSTENLEZER_BIND=0.0.0.0:8080 \
    DIENSTENLEZER_DATA_DIR=/data \
    DIENSTENLEZER_WEB_DIR=/app/dist \
    RUST_LOG=dienstenlezer=info,tower_http=info
LABEL io.hass.type="app" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="DienstenLezer" \
    org.opencontainers.image.description="Diensten-pdf's, omlopen en Qbuzz-livegegevens" \
    org.opencontainers.image.source="https://dienstenlezer.allardnet.nl"
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/health > /dev/null || exit 1
CMD ["/app/dienstenlezer-server"]
