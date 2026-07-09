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

  return useMemo(
    () =>
      filterByQuery(extensions, query, (entry) => [
        getDisplayName(entry),
        entry.name,
        entry.description,
        entry.type,
      ]).map((entry) => ({
        entry,
        state: entry.enabled ? "enabled" : "available",
      })),
    [extensions, query],
  );
}
