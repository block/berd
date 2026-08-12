import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

import { DEFAULT_LOCALE, TRANSLATION_NAMESPACES, i18n } from "@/shared/i18n";

const hasWindow = typeof window !== "undefined";

if (hasWindow) {
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
}

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

// Mock ResizeObserver for jsdom (not available by default)
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (hasWindow) {
  // Mock matchMedia for jsdom (not available by default)
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // jsdom exposes media methods but reports them as not implemented when called.
  Object.assign(HTMLMediaElement.prototype, {
    load: () => {},
    pause: () => {},
    play: () => Promise.resolve(),
  });
}

function createInMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function hasCompleteStorageApi(
  maybeStorage: Partial<Storage> | undefined,
): maybeStorage is Storage {
  return Boolean(
    maybeStorage &&
      typeof maybeStorage.getItem === "function" &&
      typeof maybeStorage.setItem === "function" &&
      typeof maybeStorage.removeItem === "function" &&
      typeof maybeStorage.clear === "function" &&
      typeof maybeStorage.key === "function",
  );
}

function ensureLocalStorage() {
  if (hasCompleteStorageApi(globalThis.localStorage)) {
    return;
  }

  const fallbackStorage = createInMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: fallbackStorage,
  });
}

if (hasWindow) {
  ensureLocalStorage();
}

async function resetTestLocale() {
  if (hasWindow) {
    ensureLocalStorage();
    localStorage.removeItem("goose:locale");
  }
  await i18n.changeLanguage(DEFAULT_LOCALE);
  await i18n.loadNamespaces(TRANSLATION_NAMESPACES);
}

beforeEach(resetTestLocale);
afterEach(resetTestLocale);
