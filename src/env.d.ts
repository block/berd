declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }

  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
  }
}

export {};
