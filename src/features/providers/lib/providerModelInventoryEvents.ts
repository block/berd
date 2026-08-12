type ProviderModelInventoryInvalidationListener = (providerId: string) => void;

const invalidationListeners =
  new Set<ProviderModelInventoryInvalidationListener>();

export function notifyProviderModelInventoryInvalidated(
  providerId: string,
): void {
  for (const listener of invalidationListeners) {
    listener(providerId);
  }
}

export function subscribeToProviderModelInventoryInvalidation(
  listener: ProviderModelInventoryInvalidationListener,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}
