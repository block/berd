export interface DistroBundleInfo {
  present: boolean;
  appVersion?: string;
  kgoose?: {
    baseUrl?: string;
    path?: string;
  };
}
