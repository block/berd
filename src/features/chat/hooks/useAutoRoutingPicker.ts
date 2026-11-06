import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  selectAutoMode,
  usePendingAutoModeStore,
} from "../lib/autoModelSelection";
import type { ChatInputAutoRouting } from "../types";

export function useAutoRoutingPicker(): ChatInputAutoRouting {
  const config = useRuntimeConfigStore(
    (state) => state.config.goose.autoRouting,
  );
  const modeId = usePendingAutoModeStore((state) => state.modeId);
  return {
    modes: config?.modes ?? [],
    selectedModeId: modeId === undefined ? config?.defaultModeId : modeId,
    onModeChange: (id) => selectAutoMode(null, id),
  };
}
