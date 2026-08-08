type ProviderModelInventoryInvalidationListener = (providerId: string) => void;

const invalidationListeners =
  new Set<ProviderModelInventoryInvalidationListener>();
const inventoryGenerations = new Map<string, number>();

export function providerModelInventoryGeneration(providerId: string): number {
  return inventoryGenerations.get(providerId) ?? 0;
}

export function notifyProviderModelInventoryInvalidated(
  providerId: string,
): void {
  inventoryGenerations.set(
    providerId,
    providerModelInventoryGeneration(providerId) + 1,
  );
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
