# syntax=docker/dockerfile:1.7
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    curl \
    file \
    git \
    jq \
    libayatana-appindicator3-dev \
    libfuse2 \
    libgtk-3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libsqlite3-dev \
    libssl-dev \
    patchelf \
    protobuf-compiler \
    rpm \
    xz-utils \
    zstd \
  && if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then \
      apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev; \
    else \
      apt-get install -y --no-install-recommends libwebkit2gtk-4.0-dev; \
    fi \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile default --default-toolchain 1.94.1 \
  && rustup toolchain install 1.92 --profile default \
  && rustup component add rustfmt clippy --toolchain 1.94.1 \
  && rustup component add rustfmt clippy --toolchain 1.92 \
  && cargo install just --locked \
  && chmod -R a+rX /usr/local/rustup /usr/local/cargo

ARG NPM_REGISTRY=

RUN --mount=type=secret,id=node_extra_ca,required=false \
  if [ -s /run/secrets/node_extra_ca ]; then \
    cp /run/secrets/node_extra_ca /usr/local/share/ca-certificates/host-extra-ca.crt; \
    update-ca-certificates; \
  fi \
  && npm config set cafile /etc/ssl/certs/ca-certificates.crt \
  && if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm config set fetch-retries 3 \
  && npm config set fetch-retry-mintimeout 10000 \
  && npm config set fetch-retry-maxtimeout 60000 \
  && npm install -g pnpm@10.33.0 --verbose \
  && pnpm config set cafile /etc/ssl/certs/ca-certificates.crt \
  && if [ -n "$NPM_REGISTRY" ]; then pnpm config set registry "$NPM_REGISTRY"; fi \
  && pnpm --version

WORKDIR /work
