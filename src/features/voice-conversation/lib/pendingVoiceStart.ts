export interface PendingVoiceStart<T> {
  current: T | null;
}

export interface DeferredPendingVoiceStart<T> {
  payload: T;
  resolve: (accepted: boolean) => void;
}

export function consumePendingVoiceStart<T>(
  pending: PendingVoiceStart<T>,
): T | null {
  const value = pending.current;
  pending.current = null;
  return value;
}

export function deferPendingVoiceStart<T>(
  pending: PendingVoiceStart<DeferredPendingVoiceStart<T>>,
  payload: T,
): Promise<boolean> {
  consumePendingVoiceStart(pending)?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending.current = { payload, resolve };
  });
}

export function cancelPendingVoiceStart<T>(
  pending: PendingVoiceStart<DeferredPendingVoiceStart<T>>,
): void {
  consumePendingVoiceStart(pending)?.resolve(false);
}

export async function continuePendingVoiceStart<T>(
  pending: PendingVoiceStart<DeferredPendingVoiceStart<T>>,
  start: (payload: T) => Promise<boolean>,
): Promise<boolean> {
  const deferred = consumePendingVoiceStart(pending);
  if (!deferred) return false;

  try {
    const accepted = await start(deferred.payload);
    deferred.resolve(accepted);
    return accepted;
  } catch {
    deferred.resolve(false);
    return false;
  }
}
