#!/usr/bin/env node
// Generates src-tauri/tauri.release.conf.json — a Tauri config overlay
// that enables the updater plugin for release builds.
//
// Tauri's `--config` flag deep-merges this overlay on top of
// tauri.conf.json, so we only need to specify the fields we want to
// override or add. Updater artifacts are produced after Apple signing, so this
// script must not set bundle.createUpdaterArtifacts.
//
// Env vars:
//   GOOSE2_UPDATER_PUBLIC_KEY — Ed25519 public key for signature verification
//   GOOSE2_UPDATER_ENDPOINT   — URL to latest.json
//   TAURI_RELEASE_CONFIG_PATH — optional output path for tests/local checks

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath =
  process.env.TAURI_RELEASE_CONFIG_PATH?.trim() ||
  resolve(__dirname, "../src-tauri/tauri.release.conf.json");

const pubkey = process.env.GOOSE2_UPDATER_PUBLIC_KEY?.trim();
const endpoint = process.env.GOOSE2_UPDATER_ENDPOINT?.trim();

if (!pubkey || !endpoint) {
  console.error(
    "[release-config] missing required GOOSE2_UPDATER_PUBLIC_KEY or GOOSE2_UPDATER_ENDPOINT",
  );
  process.exit(1);
}

const config = {
  plugins: {
    updater: {
      pubkey,
      endpoints: [endpoint],
    },
  },
};

writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[release-config] updater endpoint: ${endpoint}`);
console.log(`[release-config] wrote ${outPath}`);
