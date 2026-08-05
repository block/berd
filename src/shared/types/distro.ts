export interface DistroBundleInfo {
  present: boolean;
  kgooseConfigured: boolean;
  appVersion?: string;
  kgoose?: {
    baseUrl?: string;
    path?: string;
  };
}
