import type { ExtensionEntry } from "../types";
import { getDisplayName } from "../types";

/**
 * Native capabilities are extensions that power the agent's general-purpose
 * behavior (reading PDFs, searching the web, generating images, ...). They
 * ship with the app and "just work" — users should never need to discover,
 * connect, or manage them, so they are hidden from the Connections surface
 * and from global search.
 *
 * Two things make an extension a native capability:
 *  1. Its type is `builtin` or `platform` (the former "Goose capabilities").
 *  2. It is one of the bundled stdio tools in the curated list below.
 *
 * A real connection, by contrast, is an account the user links (Google
 * Drive, Figma, ...). Those stay visible.
 */
const NATIVE_CAPABILITY_TYPES = new Set(["builtin", "platform"]);

function toMatchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Bundled stdio tools that behave like native tools rather than linked
// accounts. Keyed on normalized config keys / names / display names.
const NATIVE_CAPABILITY_MATCH_KEYS = new Set(
  [
    "codesearch",
    "datadiscovery",
    "imagegenerator",
    "imagegen",
    "pdfreader",
    "websearch",
  ].map(toMatchKey),
);

export function isNativeCapabilityExtension(
  extension: ExtensionEntry,
): boolean {
  if (NATIVE_CAPABILITY_TYPES.has(extension.type)) {
    return true;
  }
  if (!("bundled" in extension && extension.bundled === true)) {
    return false;
  }
  const candidates = [
    extension.config_key,
    extension.name,
    getDisplayName(extension),
  ];
  return candidates.some((candidate) =>
    NATIVE_CAPABILITY_MATCH_KEYS.has(toMatchKey(candidate)),
  );
}
