import { beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultHomeWidgets,
  HOME_WIDGET_STORAGE_KEY,
  mergeFromStorage,
  useHomeWidgetStore,
} from "./homeWidgetStore";

const CANVAS_BOUNDS = { width: 1200, height: 800 };

function resetStore() {
  localStorage.removeItem(HOME_WIDGET_STORAGE_KEY);
  useHomeWidgetStore.setState({ instances: createDefaultHomeWidgets() });
}

beforeEach(async () => {
  resetStore();
  // Flush the microtask the persist middleware queues from setState above —
  // otherwise it overwrites localStorage payloads tests set up below.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("homeWidgetStore", () => {
  describe("default layout", () => {
    it("seeds a single clock widget by default", () => {
      const instances = useHomeWidgetStore.getState().instances;
      expect(instances.length).toBe(1);
      expect(instances[0].type).toBe("clock");
    });
  });

  describe("addWidget", () => {
    it("adds an instance with a uuid, snapped coords, and incremented z", () => {
      useHomeWidgetStore
        .getState()
        .addWidget("agentPin", 240, 240, { agentId: "a1" }, CANVAS_BOUNDS);
      const instances = useHomeWidgetStore.getState().instances;
      expect(instances.length).toBe(2);
      const added = instances[instances.length - 1];
      expect(added.type).toBe("agentPin");
      expect(typeof added.id).toBe("string");
      expect(added.id.length).toBeGreaterThan(0);
      expect(added.x % 24).toBe(0);
      expect(added.y % 24).toBe(0);
      expect(added.z).toBeGreaterThanOrEqual(2);
      expect(added.state).toEqual({ agentId: "a1" });
    });

    it("ignores unknown widget types", () => {
      const before = useHomeWidgetStore.getState().instances.length;
      useHomeWidgetStore
        .getState()
        .addWidget("notAType", 100, 100, undefined, CANVAS_BOUNDS);
      expect(useHomeWidgetStore.getState().instances.length).toBe(before);
    });
  });

  describe("moveWidget", () => {
    it("updates position with snap, leaves z unchanged", () => {
      useHomeWidgetStore
        .getState()
        .addWidget("clock", 240, 240, undefined, CANVAS_BOUNDS);
      const added = useHomeWidgetStore.getState().instances.at(-1);
      if (!added) {
        throw new Error("expected widget");
      }
      const origZ = added.z;
      useHomeWidgetStore.getState().moveWidget(added.id, 13, 13, CANVAS_BOUNDS);
      const moved = useHomeWidgetStore
        .getState()
        .instances.find((w) => w.id === added.id);
      if (!moved) {
        throw new Error("expected widget after move");
      }
      expect(moved.x).toBe(24);
      expect(moved.y).toBe(24);
      expect(moved.z).toBe(origZ);
    });

    it("clamps to bounds when moved past the canvas edge", () => {
      useHomeWidgetStore
        .getState()
        .addWidget("clock", 240, 240, undefined, CANVAS_BOUNDS);
      const added = useHomeWidgetStore.getState().instances.at(-1);
      if (!added) {
        throw new Error("expected widget");
      }
      useHomeWidgetStore
        .getState()
        .moveWidget(added.id, 99_999, 99_999, CANVAS_BOUNDS);
      const moved = useHomeWidgetStore
        .getState()
        .instances.find((w) => w.id === added.id);
      if (!moved) {
        throw new Error("expected widget after move");
      }
      expect(moved.x).toBeLessThanOrEqual(CANVAS_BOUNDS.width - 160);
      expect(moved.y).toBeLessThanOrEqual(CANVAS_BOUNDS.height - 160);
      expect(moved.x).toBeGreaterThanOrEqual(0);
      expect(moved.y).toBeGreaterThanOrEqual(0);
    });
  });

  describe("bumpZ", () => {
    it("sets the targeted widget's z above all others", () => {
      useHomeWidgetStore
        .getState()
        .addWidget("clock", 100, 100, undefined, CANVAS_BOUNDS);
      useHomeWidgetStore
        .getState()
        .addWidget("clock", 200, 200, undefined, CANVAS_BOUNDS);
      const first = useHomeWidgetStore.getState().instances[0];
      useHomeWidgetStore.getState().bumpZ(first.id);
      const bumped = useHomeWidgetStore
        .getState()
        .instances.find((w) => w.id === first.id);
      const others = useHomeWidgetStore
        .getState()
        .instances.filter((w) => w.id !== first.id);
      if (!bumped) {
        throw new Error("expected bumped widget");
      }
      const otherMax = Math.max(...others.map((w) => w.z));
      expect(bumped.z).toBeGreaterThan(otherMax);
    });
  });

  describe("removeWidget", () => {
    it("filters out the target instance", () => {
      useHomeWidgetStore
        .getState()
        .addWidget("agentPin", 200, 200, { agentId: "a1" }, CANVAS_BOUNDS);
      const before = useHomeWidgetStore.getState().instances;
      const target = before.at(-1);
      if (!target) {
        throw new Error("expected widget");
      }
      useHomeWidgetStore.getState().removeWidget(target.id);
      const after = useHomeWidgetStore.getState().instances;
      expect(after.find((w) => w.id === target.id)).toBeUndefined();
      expect(after.length).toBe(before.length - 1);
    });
  });

  describe("updateWidgetState", () => {
    it("merges state instead of replacing", () => {
      useHomeWidgetStore
        .getState()
        .addWidget(
          "automationOutputPin",
          200,
          200,
          { automationId: "a1" },
          CANVAS_BOUNDS,
        );
      const target = useHomeWidgetStore.getState().instances.at(-1);
      if (!target) {
        throw new Error("expected widget");
      }
      useHomeWidgetStore
        .getState()
        .updateWidgetState(target.id, { extra: "value" });
      const updated = useHomeWidgetStore
        .getState()
        .instances.find((w) => w.id === target.id);
      expect(updated?.state).toEqual({ automationId: "a1", extra: "value" });
    });
  });

  describe("persistence", () => {
    it("exposes persistence wiring with the configured storage key", () => {
      expect(useHomeWidgetStore.persist.getOptions().name).toBe(
        HOME_WIDGET_STORAGE_KEY,
      );
    });
  });

  describe("mergeFromStorage", () => {
    const baseState = {
      instances: createDefaultHomeWidgets(),
    };

    it("returns currentState when persisted payload is missing", () => {
      expect(mergeFromStorage(undefined, baseState)).toBe(baseState);
    });

    it("returns currentState when persisted.instances is not an array", () => {
      expect(mergeFromStorage({ instances: "bogus" }, baseState)).toBe(
        baseState,
      );
    });

    it("preserves an empty persisted layout (no default re-seed)", () => {
      const merged = mergeFromStorage({ instances: [] }, baseState);
      expect(merged.instances).toEqual([]);
    });

    it("filters unknown catalog types", () => {
      const persisted = {
        instances: [
          { id: "x", type: "clock", x: 0, y: 0, z: 1 },
          { id: "y", type: "ghostWidget", x: 0, y: 0, z: 2 },
        ],
      };
      const merged = mergeFromStorage(persisted, baseState);
      const types = merged.instances.map((w) => w.type);
      expect(types).toContain("clock");
      expect(types).not.toContain("ghostWidget");
    });

    it("preserves non-instance properties from currentState", () => {
      const stateWithExtra = {
        ...baseState,
        extra: "preserved",
      } as typeof baseState & { extra: string };
      const merged = mergeFromStorage({ instances: [] }, stateWithExtra);
      expect(merged.extra).toBe("preserved");
    });
  });
});
