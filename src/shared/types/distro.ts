export interface DistroBundleInfo {
  present: boolean;
  appVersion?: string;
  featureToggles?: Record<string, boolean>;
  extensionAllowlist?: string;
  kgoose?: {
    baseUrl?: string;
    path?: string;
  };
  providerAllowlist?: string;
}
