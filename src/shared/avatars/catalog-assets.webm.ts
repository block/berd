export const avatarAssetFormat = "webm" as const;

export const avatarModules = import.meta.glob<string>(
  "../assets/avatars/webm/*/*.webm",
  {
    eager: true,
    import: "default",
  },
);
