import { useEffect, useMemo, useState } from "react";
import { listExtensions } from "@/features/extensions/api/extensions";
import { isNativeCapabilityExtension } from "@/features/extensions/lib/nativeCapabilities";
import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";
import { filterByQuery } from "../lib/filterByQuery";

export interface ExtensionSearchResult {
  entry: ExtensionEntry;
  state: "enabled" | "available";
}

export function canonicalExtensionDisplayName(entry: ExtensionEntry): string {
  return getDisplayName(entry)
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}\p{Cc}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

export function extensionSearchIdentity(entry: ExtensionEntry): string {
  const backendIdentity = entry.config_key
    .replace(/-(?:platform|stdio)$/u, "")
    .toLocaleLowerCase();
  return `${canonicalExtensionDisplayName(entry)}:${backendIdentity}`;
}

let extensionCache: ExtensionEntry[] | null = null;
let extensionRequest: Promise<ExtensionEntry[]> | null = null;

function loadExtensions(): Promise<ExtensionEntry[]> {
  extensionRequest ??= listExtensions()
    .then((extensions) => {
      // Native capabilities (built-in tools) are not user-facing connections;
      // keep them out of global search so results match the Connections page.
      const visibleExtensions = extensions.filter(
        (extension) => !isNativeCapabilityExtension(extension),
      );
      extensionCache = visibleExtensions;
      return visibleExtensions;
    })
    .finally(() => {
      extensionRequest = null;
    });

  return extensionRequest;
}

export function useExtensionSearch(query: string): ExtensionSearchResult[] {
  const [extensions, setExtensions] = useState<ExtensionEntry[]>(
    () => extensionCache ?? [],
  );

  useEffect(() => {
    let cancelled = false;

    void loadExtensions()
      .then((loadedExtensions) => {
        if (!cancelled) {
          setExtensions(loadedExtensions);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExtensions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const matches = filterByQuery(extensions, query, (entry) => [
      getDisplayName(entry),
      entry.description,
    ]);
    const uniqueMatches = new Map<string, ExtensionEntry>();
    for (const entry of matches) {
      // The backend may expose the same user-facing connection through more
      // than one transport/config record. Global search is destination-first,
      // so collapse entries by their display name rather than backend type or
      // config key.
      const identity = extensionSearchIdentity(entry);
      const existing = uniqueMatches.get(identity);
      if (!existing || (!existing.enabled && entry.enabled)) {
        uniqueMatches.set(identity, entry);
      }
    }
    return [...uniqueMatches.values()].map((entry) => ({
      entry,
      state: entry.enabled ? "enabled" : "available",
    }));
  }, [extensions, query]);
}
