export function isDesignSystemExplorerEnabled() {
  return (
    import.meta.env.DEV && import.meta.env.VITE_DESIGN_SYSTEM_EXPLORER === "1"
  );
}
