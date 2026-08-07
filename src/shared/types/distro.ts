export interface DistroBundleInfo {
  present: boolean;
  kgooseConfigured: boolean;
  appVersion?: string;
  marketplace?: {
    skillUrlTemplate: string;
  };
  kgoose?: {
    baseUrl?: string;
    path?: string;
  };
}
