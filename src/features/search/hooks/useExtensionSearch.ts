import { useEffect, useMemo, useState } from "react";
import { listExtensions } from "@/features/extensions/api/extensions";
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
      extensionCache = extensions;
      return extensions;
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
