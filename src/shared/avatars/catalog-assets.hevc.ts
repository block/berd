export const avatarAssetFormat = "hevc" as const;

export const avatarModules = import.meta.glob<string>(
  "../assets/avatars/hevc/*/*.{mov,mp4}",
  {
    eager: true,
    import: "default",
  },
);
