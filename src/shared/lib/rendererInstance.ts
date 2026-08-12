import { invoke } from "@tauri-apps/api/core";

export interface RendererInstance {
  rendererId: string;
  rendererEpoch: number;
}

const rendererId = globalThis.crypto.randomUUID();
let registration: Promise<RendererInstance> | null = null;

export function getRendererInstance(): Promise<RendererInstance> {
  registration ??= invoke<number>("register_voice_renderer_instance", {
    rendererId,
  })
    .then((rendererEpoch) => ({ rendererId, rendererEpoch }))
    .catch((error) => {
      registration = null;
      throw error;
    });
  return registration;
}
