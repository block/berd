declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }

  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
    readonly VITE_ENVIRONMENT?: string;
    readonly VITE_AUTH_GATE?: string;
    readonly VITE_BYO_KEY_PROVIDERS?: string;
    readonly VITE_TELEMETRY?: string;
    readonly VITE_VOICE_DICTATION?: string;
    readonly VITE_KGOOSE_CONNECTIONS?: string;
    readonly VITE_TELEMETRY_DEBUG?: string;
    readonly VITE_DESIGN_SYSTEM_EXPLORER?: string;
    readonly VITE_BERD_G2_BASE_URL?: string;
    /** @deprecated use VITE_BERD_G2_BASE_URL. */
    readonly VITE_GOOSE_INTERNAL_G2_BASE_URL?: string;
    readonly VITE_PREVIEW_READY_UPDATE?: string;
    readonly VITE_BETA_LINEAR_LABEL_ID?: string;
    readonly VITE_RELEASE_CHANNEL_PREVIEW?: string;
  }
}

export {};
