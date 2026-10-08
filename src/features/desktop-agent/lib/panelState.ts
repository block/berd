// Panel state machine — ported from the prototype's lib/shell/panel_state.dart.
//
// Owns the avatar/expanded state machine and keeps the native panel frame,
// key-window eligibility, and persisted avatar position in sync. All
// geometry decisions delegate to anchorGeometry (pure, unit-tested); this
// class sequences the platform calls.
//
// Anti-blink sequencing:
// computeExpanded() is separated from applyExpanded() so the caller can
// commit the layout to the UI tree BEFORE the native resize — the resize
// repaint then finds a tree that already knows the layout, and the panel
// never flashes at the wrong size/position.

import {
  clampAvatarToScreens,
  computeExpandedLayout,
  rect,
  type ExpandedLayout,
  type Rect,
  type ScreenInfo,
  type Size,
} from "./anchorGeometry";

export const AVATAR_PANEL_SIZE = 94;

export type PanelMode = "avatar" | "expanded" | "menu";

/**
 * Platform seam — implemented over Tauri invoke in production, faked in
 * tests.
 */
export interface WindowPort {
  getScreens(): Promise<ScreenInfo[]>;
  getPanelFrame(): Promise<Rect>;
  setState(args: { expanded: boolean; frame: Rect }): Promise<void>;
  startDrag(): Promise<void>;
}

/** Persistence seam. */
export interface PositionStore {
  load(): Promise<{ x: number; y: number } | null>;
  save(position: { x: number; y: number }): Promise<void>;
}

export class PanelStateMachine {
  private readonly window: WindowPort;
  private readonly positionStore: PositionStore;
  readonly avatarSize: Size;
  readonly popoverSize: Size;

  private modeInternal: PanelMode = "avatar";
  /**
   * Avatar frame in global top-left coordinates. This is the anchor
   * invariant: it must not change during expand/collapse.
   */
  private avatarGlobal: Rect = rect(0, 0, AVATAR_PANEL_SIZE, AVATAR_PANEL_SIZE);

  constructor(args: {
    window: WindowPort;
    positionStore: PositionStore;
    avatarSize?: Size;
    popoverSize?: Size;
  }) {
    this.window = args.window;
    this.positionStore = args.positionStore;
    this.avatarSize = args.avatarSize ?? {
      width: AVATAR_PANEL_SIZE,
      height: AVATAR_PANEL_SIZE,
    };
    this.popoverSize = args.popoverSize ?? { width: 380, height: 520 };
  }

  get mode(): PanelMode {
    return this.modeInternal;
  }

  /** Current avatar frame (global top-left). Exposed for the UI layer. */
  get avatarFrame(): Rect {
    return this.avatarGlobal;
  }

  /**
   * Restores the persisted avatar position (clamped onto a visible screen)
   * and applies the initial avatar frame to the native panel.
   */
  async restore(): Promise<void> {
    const screens = await this.window.getScreens();
    const saved = await this.positionStore.load();
    const requested = saved
      ? rect(saved.x, saved.y, this.avatarSize.width, this.avatarSize.height)
      : await this.window.getPanelFrame();
    this.avatarGlobal = clampAvatarToScreens(
      rect(
        requested.x,
        requested.y,
        this.avatarSize.width,
        this.avatarSize.height,
      ),
      screens,
    );
    await this.window.setState({ expanded: false, frame: this.avatarGlobal });
  }

  /**
   * Computes the expanded layout WITHOUT touching the native panel, so
   * callers can commit it to the UI tree before the native resize
   * (anti-blink sequencing — see module comment). `size` overrides the
   * default popover size (the composer-only first-run popover is
   * smaller; growing to the full chat re-runs this same path).
   */
  async computeExpanded(size?: Size): Promise<ExpandedLayout> {
    if (this.modeInternal === "avatar") {
      await this.syncFromPanel();
    }
    const screens = await this.window.getScreens();
    return computeExpandedLayout({
      avatarGlobal: this.avatarGlobal,
      popoverSize: size ?? this.popoverSize,
      screens,
    });
  }

  /** Applies a layout from computeExpanded() to the native panel. */
  async applyExpanded(layout: ExpandedLayout): Promise<void> {
    await this.window.setState({ expanded: true, frame: layout.windowFrame });
    this.modeInternal = "expanded";
  }

  /**
   * Computes the layout for the avatar context menu — the same grown-
   * window geometry as the chat popover (the collapsed window is
   * avatar-sized; a menu needs room), just a different overlay size and a
   * distinct mode so gesture guards can tell menu from chat.
   */
  async computeMenu(size: Size): Promise<ExpandedLayout> {
    return this.computeExpanded(size);
  }

  /** Applies a layout from computeMenu() to the native panel. */
  async applyMenu(layout: ExpandedLayout): Promise<void> {
    await this.window.setState({ expanded: true, frame: layout.windowFrame });
    this.modeInternal = "menu";
  }

  /**
   * Collapses back to the avatar-only frame and returns key status to the
   * previously active app.
   */
  async collapse(): Promise<void> {
    await this.window.setState({ expanded: false, frame: this.avatarGlobal });
    this.modeInternal = "avatar";
  }

  /**
   * Restores the last persisted free-floating avatar position. Used when a
   * native perch relationship ends without a drag dismount.
   */
  async returnToSavedPosition(): Promise<void> {
    if (this.modeInternal !== "avatar") return;
    const screens = await this.window.getScreens();
    const saved = await this.positionStore.load();
    const requested = saved
      ? rect(saved.x, saved.y, this.avatarSize.width, this.avatarSize.height)
      : await this.window.getPanelFrame();
    this.avatarGlobal = clampAvatarToScreens(
      rect(
        requested.x,
        requested.y,
        this.avatarSize.width,
        this.avatarSize.height,
      ),
      screens,
    );
    await this.window.setState({ expanded: false, frame: this.avatarGlobal });
    this.modeInternal = "avatar";
  }

  /**
   * Re-reads the current avatar frame WITHOUT saving the free position —
   * native perch placement owns the panel while perched.
   */
  async onDragEndedPerched(): Promise<void> {
    return this.syncFromPanel();
  }

  /**
   * Hands the in-flight pointer sequence to native performDrag. Only valid
   * in avatar mode (dragging is disabled while expanded).
   */
  async onDragStarted(): Promise<void> {
    if (this.modeInternal !== "avatar")
      throw new Error("drag only in avatar mode");
    return this.window.startDrag();
  }

  /**
   * Called after a native drag completes: re-reads the panel frame, clamps
   * it onto a visible screen, and persists the new avatar position.
   */
  async onDragEnded(): Promise<void> {
    if (this.modeInternal !== "avatar")
      throw new Error("drag only in avatar mode");
    const screens = await this.window.getScreens();
    const frame = await this.window.getPanelFrame();
    this.avatarGlobal = clampAvatarToScreens(
      rect(frame.x, frame.y, this.avatarSize.width, this.avatarSize.height),
      screens,
    );
    if (this.avatarGlobal.x !== frame.x || this.avatarGlobal.y !== frame.y) {
      await this.window.setState({ expanded: false, frame: this.avatarGlobal });
    }
    await this.positionStore.save({
      x: this.avatarGlobal.x,
      y: this.avatarGlobal.y,
    });
  }

  /**
   * Re-reads the current avatar frame without changing the free-position
   * store.
   */
  async syncFromPanel(): Promise<void> {
    const frame = await this.window.getPanelFrame();
    this.avatarGlobal = rect(
      frame.x,
      frame.y,
      this.avatarSize.width,
      this.avatarSize.height,
    );
  }
}
