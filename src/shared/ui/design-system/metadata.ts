type MetadataValue = string | number | boolean | null | undefined;

type DesignSystemMetadata = {
  component: string;
  slot?: string;
  source?: string;
  variant?: MetadataValue;
  size?: MetadataValue;
  props?: Record<string, MetadataValue>;
  customClassName?: MetadataValue;
};

const metadataEnabled =
  import.meta.env.DEV && import.meta.env.VITE_DESIGN_SYSTEM_EXPLORER === "1";

function cleanEntries(values: Record<string, MetadataValue>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value != null && value !== ""),
  ) as Record<string, string | number | boolean>;
}

export function getDesignSystemMetadata({
  component,
  slot,
  source,
  variant,
  size,
  props,
  customClassName,
}: DesignSystemMetadata) {
  if (!metadataEnabled) {
    return {};
  }

  const serializedProps = cleanEntries({
    variant,
    size,
    ...(props ?? {}),
  });

  return cleanEntries({
    "data-ds-component": component,
    "data-ds-slot": slot,
    "data-ds-source": source,
    "data-ds-variant": variant,
    "data-ds-size": size,
    "data-ds-props":
      Object.keys(serializedProps).length > 0
        ? JSON.stringify(serializedProps)
        : undefined,
    "data-ds-custom-class": customClassName,
  });
}
