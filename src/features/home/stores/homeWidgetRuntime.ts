import { toast } from "sonner";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutItems,
  type Layout,
} from "@/features/layout/api/layout";
import { i18n } from "@/shared/i18n";
import {
  createDefaultClockLayoutItem,
  homeWidgetsToLayoutItems,
  HOME_LAYOUT_REPLACE_KINDS,
  layoutItemsToHomeWidgets,
} from "../lib/homeLayoutMapper";
import type { WidgetInstance } from "../widgets/types";

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type SaveStatus = "idle" | "saving";

export type HomeWidgetState = {
  instances: WidgetInstance[];
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  error: string | null;
  itemRevision: number | null;
  lastConfirmedLayout: Layout | null;
};

type StatePatch =
  | Partial<HomeWidgetState>
  | ((state: HomeWidgetState) => Partial<HomeWidgetState>);

type HomeWidgetRuntimeOptions = {
  getState: () => HomeWidgetState;
  setState: (patch: StatePatch) => void;
};

type RuntimeState = {
  generation: number;
  initializePromise: Promise<void> | null;
  queuedInstances: WidgetInstance[] | null;
  saveLoopPromise: Promise<void> | null;
  saveLoopGeneration: number | null;
};

export const MAX_STARTUP_ATTEMPTS = 3;

export const initialHomeWidgetState = {
  instances: [],
  loadStatus: "idle",
  saveStatus: "idle",
  error: null,
  itemRevision: null,
  lastConfirmedLayout: null,
} satisfies HomeWidgetState;

function formatErrorDetails(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const details = [
      error.name ? `name: ${error.name}` : null,
      error.message ? `message: ${error.message}` : null,
      error.stack ? `stack: ${error.stack}` : null,
      "cause" in error && error.cause !== undefined
        ? `cause: ${formatErrorDetails(error.cause)}`
        : null,
    ].filter(Boolean);

    return details.length > 0 ? details.join("\n") : String(error);
  }
  return String(error);
}

function adoptLayout(
  layout: Layout,
): Pick<HomeWidgetState, "instances" | "itemRevision" | "lastConfirmedLayout"> {
  return {
    instances: layoutItemsToHomeWidgets(layout.items),
    itemRevision: layout.itemRevision,
    lastConfirmedLayout: layout,
  };
}

export function createHomeWidgetRuntime({
  getState,
  setState,
}: HomeWidgetRuntimeOptions) {
  const runtime: RuntimeState = {
    generation: 0,
    initializePromise: null,
    queuedInstances: null,
    saveLoopPromise: null,
    saveLoopGeneration: null,
  };

  function setReadyLayout(layout: Layout, generation: number): void {
    if (generation !== runtime.generation) {
      return;
    }

    setState({
      ...adoptLayout(layout),
      loadStatus: "ready",
      error: null,
    });
  }

  async function loadFromBackend(generation: number): Promise<void> {
    let lastError = "";

    for (let attempt = 0; attempt < MAX_STARTUP_ATTEMPTS; attempt += 1) {
      try {
        const layout = await getLayout(HOME_LAYOUT_ID);
        if (generation !== runtime.generation) {
          return;
        }

        const instances = layoutItemsToHomeWidgets(layout.items);
        if (instances.length > 0) {
          setReadyLayout(layout, generation);
          return;
        }

        const result = await saveLayoutItems({
          layoutId: HOME_LAYOUT_ID,
          expectedRevision: layout.itemRevision,
          replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
          items: [createDefaultClockLayoutItem()],
        });
        if (generation !== runtime.generation) {
          return;
        }
        // During default seeding, a revision conflict means another writer
        // already created a newer backend layout. There are no local edits to
        // preserve yet, so initialization adopts the returned conflict layout.
        setReadyLayout(result.layout, generation);
        return;
      } catch (error) {
        if (generation !== runtime.generation) {
          return;
        }
        lastError = formatErrorDetails(error);
      }
    }

    if (generation !== runtime.generation) {
      return;
    }

    setState({
      loadStatus: "error",
      error: lastError,
    });
  }

  function initialize(force = false): Promise<void> {
    const { itemRevision, loadStatus } = getState();
    if (!force && loadStatus === "ready" && itemRevision !== null) {
      return Promise.resolve();
    }

    if (!force && runtime.initializePromise) {
      return runtime.initializePromise;
    }

    runtime.generation += 1;
    runtime.queuedInstances = null;
    const generation = runtime.generation;

    setState({
      ...initialHomeWidgetState,
      loadStatus: "loading",
    });

    runtime.initializePromise = loadFromBackend(generation).finally(() => {
      // A reset or fresh initialize advances the generation; older callers may
      // still await their promise, but it must not clear the active request.
      if (generation === runtime.generation) {
        runtime.initializePromise = null;
      }
    });
    return runtime.initializePromise;
  }

  function retryInitialize(): Promise<void> {
    const { loadStatus } = getState();
    if (loadStatus === "loading" && runtime.initializePromise) {
      return runtime.initializePromise;
    }
    if (loadStatus !== "error") {
      return Promise.resolve();
    }
    return initialize(true);
  }

  async function drainSaveQueue(): Promise<void> {
    const generation = runtime.generation;
    if (runtime.saveLoopPromise && runtime.saveLoopGeneration === generation) {
      return runtime.saveLoopPromise;
    }

    runtime.saveLoopGeneration = generation;

    const loopPromise = (async () => {
      setState({ saveStatus: "saving" });
      try {
        while (runtime.queuedInstances) {
          const instances = runtime.queuedInstances;
          runtime.queuedInstances = null;
          const expectedRevision = getState().itemRevision;
          if (expectedRevision === null) {
            continue;
          }

          try {
            const result = await saveLayoutItems({
              layoutId: HOME_LAYOUT_ID,
              expectedRevision,
              replaceKinds: HOME_LAYOUT_REPLACE_KINDS,
              items: homeWidgetsToLayoutItems(instances),
            });

            if (generation !== runtime.generation) {
              break;
            }

            if (!result.ok) {
              runtime.queuedInstances = null;
              setState({
                ...adoptLayout(result.layout),
                error: null,
              });
              toast.warning(i18n.t("home:widgetLayer.toasts.conflict"));
              break;
            }

            const confirmed = adoptLayout(result.layout);
            setState((current) => ({
              ...confirmed,
              instances: runtime.queuedInstances
                ? current.instances
                : confirmed.instances,
              error: null,
            }));
          } catch {
            if (generation !== runtime.generation) {
              break;
            }

            const { lastConfirmedLayout } = getState();
            runtime.queuedInstances = null;
            setState({
              ...(lastConfirmedLayout ? adoptLayout(lastConfirmedLayout) : {}),
              error: null,
            });
            toast.error(i18n.t("home:widgetLayer.toasts.saveFailed"));
            break;
          }
        }
      } finally {
        if (
          generation === runtime.generation &&
          runtime.saveLoopGeneration === generation
        ) {
          runtime.saveLoopPromise = null;
          runtime.saveLoopGeneration = null;
          setState({ saveStatus: "idle" });
        }
      }
    })();

    runtime.saveLoopPromise = loopPromise;
    return loopPromise;
  }

  function enqueueSave(instances: WidgetInstance[]): void {
    runtime.queuedInstances = instances;
    void drainSaveQueue();
  }

  function __resetForTests__(): void {
    // Callers awaiting an in-flight initialize may receive a resolved promise
    // without any state change after reset advances the active generation.
    runtime.generation += 1;
    runtime.initializePromise = null;
    runtime.queuedInstances = null;
    runtime.saveLoopPromise = null;
    runtime.saveLoopGeneration = null;
    setState(initialHomeWidgetState);
  }

  return {
    initialize,
    retryInitialize,
    enqueueSave,
    __resetForTests__,
  };
}
