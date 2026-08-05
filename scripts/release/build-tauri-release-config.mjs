#!/usr/bin/env node
// Generates src-tauri/tauri.release.conf.json, a Tauri config overlay for one
// explicit updater release channel. Endpoint and verification key are a single
// build-time trust contract; this script never infers or falls back between
// channels.
//
// Env vars:
//   BERD_RELEASE_CHANNEL     public | internal | disabled
//   BERD_UPDATER_PUBLIC_KEY  Tauri Ed25519 public key (enabled channels only)
//   BERD_UPDATER_ENDPOINT    HTTPS URL to latest.json (enabled channels only)
//   TAURI_RELEASE_CONFIG_PATH optional output path for tests/local checks

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath =
  process.env.TAURI_RELEASE_CONFIG_PATH?.trim() ||
  resolve(__dirname, "../../src-tauri/tauri.release.conf.json");

const channel = process.env.BERD_RELEASE_CHANNEL?.trim();
const pubkey = process.env.BERD_UPDATER_PUBLIC_KEY?.trim();
const endpoint = process.env.BERD_UPDATER_ENDPOINT?.trim();
const enabledChannels = new Set(["public", "internal"]);

if (!channel || (!enabledChannels.has(channel) && channel !== "disabled")) {
  console.error(
    `[release-config] BERD_RELEASE_CHANNEL must be public, internal, or disabled; got ${JSON.stringify(channel ?? "")}`,
  );
  process.exit(1);
}

if (channel === "disabled") {
  if (pubkey || endpoint) {
    console.error(
      "[release-config] disabled channel must not receive BERD_UPDATER_PUBLIC_KEY or BERD_UPDATER_ENDPOINT",
    );
    process.exit(1);
  }

  writeFileSync(outPath, `${JSON.stringify({}, null, 2)}\n`);
  console.log("[release-config] updater channel: disabled");
  console.log(`[release-config] wrote ${outPath}`);
  process.exit(0);
}

if (!pubkey || !endpoint) {
  console.error(
    `[release-config] ${channel} channel requires both BERD_UPDATER_PUBLIC_KEY and BERD_UPDATER_ENDPOINT`,
  );
  process.exit(1);
}

let parsedEndpoint;
try {
  parsedEndpoint = new URL(endpoint);
} catch {
  console.error("[release-config] BERD_UPDATER_ENDPOINT must be a valid URL");
  process.exit(1);
}

if (
  parsedEndpoint.protocol !== "https:" ||
  parsedEndpoint.username ||
  parsedEndpoint.password ||
  parsedEndpoint.hash
) {
  console.error(
    "[release-config] BERD_UPDATER_ENDPOINT must be credential-free HTTPS without a fragment",
  );
  process.exit(1);
}

const config = {
  plugins: {
    updater: {
      pubkey,
      endpoints: [parsedEndpoint.href],
    },
  },
};

writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[release-config] updater channel: ${channel}`);
console.log(`[release-config] updater endpoint: ${parsedEndpoint.href}`);
console.log(`[release-config] wrote ${outPath}`);
