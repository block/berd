#!/usr/bin/env node
// Generates the Tauri updater overlay plus a bundled, finite release catalog.
// Endpoint and verification key remain one build-time trust contract. The
// renderer can select only a catalog ID; it never supplies a URL or key.
//
// Env vars:
//   BERD_RELEASE_CHANNEL       public | internal | disabled (legacy profile)
//   BERD_UPDATER_PUBLIC_KEY    Tauri Ed25519 public key (legacy enabled profile)
//   BERD_UPDATER_ENDPOINT      HTTPS latest.json URL (legacy enabled profile)
//   BERD_RELEASE_CHANNELS_FILE optional reviewed catalog JSON
//   BERD_RELEASE_CHANNEL_ID   current binary's catalog ID (defaults to catalog default)
//   TAURI_RELEASE_CONFIG_PATH  optional overlay output path
//   BERD_RELEASE_CATALOG_OUTPUT optional catalog output path

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath =
  process.env.TAURI_RELEASE_CONFIG_PATH?.trim() ||
  resolve(__dirname, "../../src-tauri/tauri.release.conf.json");
const catalogOutPath =
  process.env.BERD_RELEASE_CATALOG_OUTPUT?.trim() ||
  resolve(__dirname, "../../src-tauri/resources/release-channels.json");
const catalogSourcePath = process.env.BERD_RELEASE_CHANNELS_FILE?.trim();
const runningChannelId = process.env.BERD_RELEASE_CHANNEL_ID?.trim();
const legacyProfile = process.env.BERD_RELEASE_CHANNEL?.trim();
const legacyPubkey = process.env.BERD_UPDATER_PUBLIC_KEY?.trim();
const legacyEndpoint = process.env.BERD_UPDATER_ENDPOINT?.trim();
const enabledLegacyProfiles = new Set(["public", "internal"]);
const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const REQUIRED_COMPATIBILITY_KEYS = [
  "storeContractVersion",
  "writesDataEpoch",
  "minReadableDataEpoch",
  "maxReadableDataEpoch",
];

function fail(message) {
  console.error(`[release-config] ${message}`);
  process.exit(1);
}

function validateEndpoint(value, context) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${context} must be a valid URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail(`${context} must be credential-free HTTPS without a fragment`);
  }
  return parsed.href;
}

function requiredString(value, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, context) {
  if (value == null) return undefined;
  return requiredString(value, context);
}

function requiredEpoch(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${context} must be a non-negative integer`);
  }
  return value;
}

function validateCompatibility(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const extraKeys = Object.keys(value).filter(
    (key) => !REQUIRED_COMPATIBILITY_KEYS.includes(key),
  );
  if (extraKeys.length > 0) {
    fail(`${context} contains unknown keys: ${extraKeys.join(", ")}`);
  }
  const compatibility = {
    storeContractVersion: requiredEpoch(
      value.storeContractVersion,
      `${context}.storeContractVersion`,
    ),
    writesDataEpoch: requiredEpoch(
      value.writesDataEpoch,
      `${context}.writesDataEpoch`,
    ),
    minReadableDataEpoch: requiredEpoch(
      value.minReadableDataEpoch,
      `${context}.minReadableDataEpoch`,
    ),
    maxReadableDataEpoch: requiredEpoch(
      value.maxReadableDataEpoch,
      `${context}.maxReadableDataEpoch`,
    ),
  };
  if (compatibility.minReadableDataEpoch > compatibility.maxReadableDataEpoch) {
    fail(`${context} has an inverted readable epoch range`);
  }
  if (
    compatibility.writesDataEpoch < compatibility.minReadableDataEpoch ||
    compatibility.writesDataEpoch > compatibility.maxReadableDataEpoch
  ) {
    fail(`${context}.writesDataEpoch must be inside its readable epoch range`);
  }
  return compatibility;
}

function normalizeCatalog(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(`${context} must be a JSON object`);
  }
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1) {
    fail(`${context}.schemaVersion must be 1`);
  }
  const defaultChannel = requiredString(
    input.defaultChannel,
    `${context}.defaultChannel`,
  );
  const currentBuildChannel = runningChannelId || defaultChannel;
  if (!CHANNEL_ID_PATTERN.test(defaultChannel)) {
    fail(`${context}.defaultChannel is not a valid channel ID`);
  }
  if (!Array.isArray(input.channels) || input.channels.length === 0) {
    fail(`${context}.channels must contain at least one channel`);
  }

  const ids = new Set();
  const labels = new Set();
  const endpoints = new Set();
  const channels = input.channels.map((candidate, index) => {
    const itemContext = `${context}.channels[${index}]`;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail(`${itemContext} must be an object`);
    }
    const id = requiredString(candidate.id, `${itemContext}.id`);
    if (!CHANNEL_ID_PATTERN.test(id)) {
      fail(`${itemContext}.id must match ${CHANNEL_ID_PATTERN}`);
    }
    if (ids.has(id)) fail(`${context} contains duplicate channel ID ${id}`);
    ids.add(id);

    const label = requiredString(candidate.label, `${itemContext}.label`);
    const normalizedLabel = label.toLocaleLowerCase("en-US");
    if (labels.has(normalizedLabel)) {
      fail(`${context} contains duplicate channel label ${label}`);
    }
    labels.add(normalizedLabel);

    const endpoint = validateEndpoint(
      candidate.endpoint,
      `${itemContext}.endpoint`,
    );
    if (endpoints.has(endpoint)) {
      fail(`${context} contains duplicate channel endpoint ${endpoint}`);
    }
    endpoints.add(endpoint);

    const pubkey = requiredString(candidate.pubkey, `${itemContext}.pubkey`);

    const channel = {
      id,
      label,
      endpoint,
      pubkey,
      compatibility: validateCompatibility(
        candidate.compatibility ?? candidate.runningBuild?.compatibility,
        `${itemContext}.compatibility`,
      ),
    };
    const description = optionalString(
      candidate.description,
      `${itemContext}.description`,
    );
    const whatToTest = optionalString(
      candidate.whatToTest,
      `${itemContext}.whatToTest`,
    );
    if (description) channel.description = description;
    if (whatToTest) channel.whatToTest = whatToTest;
    return channel;
  });

  if (!ids.has(defaultChannel)) {
    fail(`${context}.defaultChannel must reference a catalog entry`);
  }
  if (!ids.has(currentBuildChannel)) {
    fail(`BERD_RELEASE_CHANNEL_ID must reference a catalog entry`);
  }
  const runningEntry = channels.find(
    (entry) => entry.id === currentBuildChannel,
  );

  return {
    schemaVersion,
    defaultChannel,
    runningBuild: {
      channelId: currentBuildChannel,
      compatibility: runningEntry.compatibility,
    },
    channels,
  };
}

function legacyCatalog() {
  if (
    !legacyProfile ||
    (!enabledLegacyProfiles.has(legacyProfile) && legacyProfile !== "disabled")
  ) {
    fail(
      `BERD_RELEASE_CHANNEL must be public, internal, or disabled; got ${JSON.stringify(legacyProfile ?? "")}`,
    );
  }
  if (legacyProfile === "disabled") {
    if (legacyPubkey || legacyEndpoint) {
      fail(
        "disabled channel must not receive BERD_UPDATER_PUBLIC_KEY or BERD_UPDATER_ENDPOINT",
      );
    }
    return null;
  }
  if (!legacyPubkey || !legacyEndpoint) {
    fail(
      `${legacyProfile} channel requires both BERD_UPDATER_PUBLIC_KEY and BERD_UPDATER_ENDPOINT`,
    );
  }
  return {
    schemaVersion: 1,
    defaultChannel: "main",
    runningBuild: {
      channelId: "main",
      compatibility: {
        storeContractVersion: 1,
        writesDataEpoch: 1,
        minReadableDataEpoch: 1,
        maxReadableDataEpoch: 1,
      },
    },
    channels: [
      {
        id: "main",
        label: "Main",
        description: "Recommended releases",
        endpoint: legacyEndpoint,
        pubkey: legacyPubkey,
        compatibility: {
          storeContractVersion: 1,
          writesDataEpoch: 1,
          minReadableDataEpoch: 1,
          maxReadableDataEpoch: 1,
        },
      },
    ],
  };
}

if (catalogSourcePath && (legacyPubkey || legacyEndpoint)) {
  fail(
    "BERD_RELEASE_CHANNELS_FILE cannot be combined with legacy BERD_UPDATER_PUBLIC_KEY or BERD_UPDATER_ENDPOINT",
  );
}

let catalogInput;
if (catalogSourcePath) {
  try {
    catalogInput = JSON.parse(readFileSync(catalogSourcePath, "utf8"));
  } catch (error) {
    fail(`failed to read BERD_RELEASE_CHANNELS_FILE: ${error.message}`);
  }
} else {
  catalogInput = legacyCatalog();
}

if (catalogInput === null) {
  writeFileSync(outPath, `${JSON.stringify({}, null, 2)}\n`);
  writeFileSync(
    catalogOutPath,
    `${JSON.stringify({ schemaVersion: 1, disabled: true }, null, 2)}\n`,
  );
  console.log("[release-config] updater catalog: disabled");
  console.log(`[release-config] wrote ${outPath}`);
  console.log(`[release-config] wrote ${catalogOutPath}`);
  process.exit(0);
}

const catalog = normalizeCatalog(
  catalogInput,
  catalogSourcePath ? "release catalog" : "legacy release catalog",
);
const defaultEntry = catalog.channels.find(
  (entry) => entry.id === catalog.defaultChannel,
);
const config = {
  plugins: {
    updater: {
      pubkey: defaultEntry.pubkey,
      endpoints: [defaultEntry.endpoint],
    },
  },
  bundle: {
    resources: {
      "resources/release-channels.json": "release-channels.json",
    },
  },
};

writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(catalogOutPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(
  `[release-config] updater catalog: ${catalog.channels.map((entry) => entry.id).join(", ")}`,
);
console.log(`[release-config] default channel: ${catalog.defaultChannel}`);
console.log(`[release-config] wrote ${outPath}`);
console.log(`[release-config] wrote ${catalogOutPath}`);
