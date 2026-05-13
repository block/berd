declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }

  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
    readonly VITE_PREVIEW_READY_UPDATE?: string;
  }
}

export {};
