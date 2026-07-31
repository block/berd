FROM rust:1.91.1-bookworm AS build

WORKDIR /src
COPY . .
WORKDIR /src/bb-cli
RUN cargo build --locked --release --bin bb

FROM python:3.12-slim-bookworm

RUN groupadd --gid 10001 acceptance && useradd --uid 10001 --gid acceptance --create-home --shell /usr/sbin/nologin acceptance
COPY --from=build /src/bb-cli/target/release/bb /usr/local/bin/bb
COPY --chown=acceptance:acceptance --chmod=755 bb-cli/docker/acceptance /opt/bb-acceptance

USER acceptance
ENTRYPOINT ["/opt/bb-acceptance/run-acceptance.sh"]
