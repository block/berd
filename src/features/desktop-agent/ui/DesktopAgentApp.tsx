// Desktop-agent webview shell: animated avatar, popover chat, native
// panel geometry, the right-click agent menu, and the perch
// choreography (targeting rides the avatar drag; the drop decision
// lands at pointer-up). The Rust side (src-tauri/src/desktop_agent)
// owns the AppKit seams; this component composes the UI state machines
// and keeps the transparent panel window honest.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";

import {
  popoverGlobal,
  type ExpandedLayout,
  type Size,
} from "../lib/anchorGeometry";
import { deriveAvatarState } from "../lib/avatarState";
import { setDesktopAgentEnabled } from "../lib/desktopAgentPreferences";
import { PanelStateMachine } from "../lib/panelState";
import {
  LocalStoragePositionStore,
  TauriWindowPort,
} from "../lib/tauriWindowPort";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { useAvatarMenu, type AvatarMenuModel } from "../hooks/useAvatarMenu";
import { usePerch } from "../hooks/usePerch";
import { useSession } from "../hooks/useSession";
import { AgentAvatar } from "./AgentAvatar";
import { AvatarMenu, menuOverlaySize } from "./AvatarMenu";
import { ChatPopover } from "./ChatPopover";
import "./desktop-agent.css";

// Distinguish an intentional stationary hold from an ordinary chat click.
const HOLD_DELAY_MS = 180;

// Composer-first: a chat with no messages opens as just the composer
// pill — room for the pill plus the hint row when one is relevant.
const COMPOSER_ONLY_SIZE: Size = { width: 380, height: 96 };
// Composer-only bubble pill height (desktop-agent.css:
// .composer-only .composer-box padding 9px around the 26px send pill,
// plus 1px border ×2). Used before the DOM exists to measure the pill.
export const BUBBLE_PILL_HEIGHT = 46;
const FULL_PANEL_PADDING = 16;

export function bubbleComposerBottomGlobal(layout: ExpandedLayout): number {
  return (
    layout.windowFrame.y +
    layout.popoverRect.y +
    layout.popoverRect.height / 2 +
    BUBBLE_PILL_HEIGHT / 2
  );
}

function readComposerBottomInset(popover: HTMLElement, composer: HTMLElement) {
  // Measured while still in composer mode, where .panel-popover's padding
  // is 0 — so read the FULL layout's padding from the shared custom
  // property (desktop-agent.css #root), not the current computed padding.
  const padding = Number.parseFloat(
    getComputedStyle(popover).getPropertyValue("--desktop-agent-panel-padding"),
  );
  const margin = Number.parseFloat(getComputedStyle(composer).marginBottom);
  return (
    (Number.isFinite(padding) ? padding : 16) +
    (Number.isFinite(margin) ? margin : 0)
  );
}

const machine = new PanelStateMachine({
  window: new TauriWindowPort(),
  positionStore: new LocalStoragePositionStore(),
});

export function DesktopAgentApp() {
  const { t } = useTranslation("desktop-agent");
  const session = useSession();
  const agentSelector =
    useExperiment(DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID)?.enabled === true;
  // Set when "Turn off agent" has fired: the enabled-pref write is in flight
  // to the main webview's bridge (which closes the panel); meanwhile the
  // panel must already look gone.
  const [turnedOff, setTurnedOff] = useState(false);
  const avatarAgentId =
    session.pendingSelection !== null
      ? session.pendingSelection.kind === "agent"
        ? session.pendingSelection.agent.agentId
        : null
      : session.activeAgentId;
  const avatar = useAgentAvatar(avatarAgentId);
  // Berdy is always the animated character; other agents keep their
  // avatars.
  const character = avatar.isBerdy;
  const [dragActive, setDragActive] = useState(false);
  const [holdActive, setHoldActive] = useState(false);
  // Perch ended natively. Reason decides placement: window CLOSED →
  // avatar flies home to the saved free position; window MINIMIZED →
  // auto-unperch but the avatar STAYS where it was seated (syncing the
  // frame so panelState owns the spot without saving it as home).
  // Dismounts and drag-offs do NOT route through this — they own their
  // own placement.
  const perch = usePerch((reason) => {
    if (reason === "minimized") {
      void machine.syncFromPanel();
    } else {
      void machine.returnToSavedPosition();
    }
  }, character);
  const [layout, setLayout] = useState<ExpandedLayout | null>(null);
  const [lastAvatarRect, setLastAvatarRect] = useState<
    ExpandedLayout["avatarRect"] | null
  >(null);
  const [expandedApplied, setExpandedApplied] = useState(0);
  // Composer-first: "composer" until the chat has messages, then "full".
  const [popoverVariant, setPopoverVariant] = useState<"composer" | "full">(
    "full",
  );
  const [menu, setMenu] = useState<{
    layout: ExpandedLayout;
    model: AvatarMenuModel;
  } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [restored, setRestored] = useState(false);
  const collapsing = useRef(false);
  const closingMenu = useRef(false);
  const openingMenu = useRef(false);
  const dragging = useRef(false);
  const ignoreNextClick = useRef(false);
  const avatarTriggerRef = useRef<HTMLDivElement>(null);
  const pointerDownAt = useRef<{
    x: number;
    y: number;
    id: number;
    element: Element;
    held: boolean;
  } | null>(null);
  const holdTimer = useRef<number | null>(null);
  // Do not overlap native hit-test/attach and a second native drag. A regrab
  // may still hold immediately; its next move can drag once the drop settles.
  const dropPending = useRef(false);
  const gestureGeneration = useRef(0);
  const sessionMessageCount = useRef(session.messages.length);
  sessionMessageCount.current = session.messages.length;

  const clearHoldTimer = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  const clearPress = useCallback(() => {
    clearHoldTimer();
    const press = pointerDownAt.current;
    pointerDownAt.current = null;
    setHoldActive(false);
    // Clear the ref first: releasing capture can synchronously send lostcapture.
    if (press?.element.hasPointerCapture?.(press.id)) {
      press.element.releasePointerCapture(press.id);
    }
  }, [clearHoldTimer]);

  // Startup: restore persisted position (clamped) before showing anything.
  useEffect(() => {
    machine.restore().then(() => setRestored(true));
  }, []);

  const collapse = useCallback(async () => {
    gestureGeneration.current++;
    if (collapsing.current || machine.mode !== "expanded") return;
    collapsing.current = true;
    try {
      // Anti-blink: drop the popover from the tree BEFORE the native
      // shrink, so the resize repaint never shows a stale popover.
      if (layout) setLastAvatarRect(layout.avatarRect);
      setLayout(null);
      await machine.collapse();
      setLastAvatarRect(null);
    } finally {
      collapsing.current = false;
    }
  }, [layout]);

  const expand = useCallback(async (options?: { composerOnly?: boolean }) => {
    if (openingMenu.current || machine.mode !== "avatar") return;
    const generation = ++gestureGeneration.current;
    // Composer-first: an empty chat (nothing to show, including reopen
    // of a still-empty chat) opens as just the composer pill; a chat
    // with messages opens as the full window. New Chat forces the
    // composer-only view before React lands the cleared transcript.
    const composerOnly =
      options?.composerOnly ?? sessionMessageCount.current === 0;
    // Anti-blink: compute first, commit to the tree, THEN resize native.
    // Both variants sit BESIDE the avatar like a speech bubble. The full
    // chat is laid out as if grown from the composer bubble: its composer
    // is level with where the bubble's pill would be, transcript above —
    // so reopening an existing chat matches the grow-in-place geometry.
    const bubble = await machine.computeExpanded(COMPOSER_ONLY_SIZE, "side");
    let next = bubble;
    if (!composerOnly) {
      next =
        bubble.popoverSide === null
          ? await machine.computeExpanded() // no side room: above/below
          : await machine.computeGrown({
              fromPopoverGlobal: popoverGlobal(bubble),
              // The bubble's pill is vertically centered in its region
              // (anchor-center); align the full composer bottom to that
              // measured composer-only pill bottom, ignoring the hint row.
              composerBottomGlobal: bubbleComposerBottomGlobal(bubble),
              bottomInset: FULL_PANEL_PADDING,
              fromPopoverSide: bubble.popoverSide,
            });
    }
    if (generation !== gestureGeneration.current || machine.mode !== "avatar") {
      return;
    }
    setPopoverVariant(composerOnly ? "composer" : "full");
    setLayout(next);
    await machine.applyExpanded(next);
    setExpandedApplied((count) => count + 1);
  }, []);

  // First message sent while composer-only: grow to the full chat window
  // through the same anti-blink path (compute, commit to tree, THEN
  // native resize — the avatar stays put).
  const popoverElement = useRef<HTMLDivElement>(null);
  const composerElement = useRef<HTMLDivElement>(null);
  const growing = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expandedApplied retries when the first message arrives before applyExpanded flips native mode.
  useEffect(() => {
    if (
      layout === null ||
      popoverVariant !== "composer" ||
      session.messages.length === 0 ||
      growing.current
    )
      return;
    growing.current = true;
    void (async () => {
      try {
        if (machine.mode !== "expanded") return;
        const generation = gestureGeneration.current;
        const fromPopoverSide = layout.popoverSide;
        const popover = popoverElement.current;
        const composer = composerElement.current;
        const next =
          fromPopoverSide !== null && popover && composer
            ? await machine.computeGrown({
                fromPopoverGlobal: {
                  ...popoverGlobal(layout),
                },
                composerBottomGlobal:
                  layout.windowFrame.y +
                  composer.getBoundingClientRect().bottom,
                bottomInset: readComposerBottomInset(popover, composer),
                fromPopoverSide,
              })
            : await machine.computeExpanded();
        if (
          generation !== gestureGeneration.current ||
          machine.mode !== "expanded"
        ) {
          return;
        }
        setPopoverVariant("full");
        setLayout(next);
        await machine.applyExpanded(next);
        setExpandedApplied((count) => count + 1);
      } finally {
        growing.current = false;
      }
    })();
  }, [layout, popoverVariant, session.messages.length, expandedApplied]);

  const closeMenu = useCallback(
    async (options?: { restoreAvatarFocus?: boolean }) => {
      gestureGeneration.current++;
      if (closingMenu.current || machine.mode !== "menu") {
        if (options?.restoreAvatarFocus) avatarTriggerRef.current?.focus();
        return;
      }
      closingMenu.current = true;
      try {
        // Anti-blink, in reverse: drop the menu from the tree first.
        if (menu) setLastAvatarRect(menu.layout.avatarRect);
        setMenu(null);
        await machine.collapse();
        setLastAvatarRect(null);
        if (options?.restoreAvatarFocus) avatarTriggerRef.current?.focus();
      } finally {
        closingMenu.current = false;
      }
    },
    [menu],
  );

  // "Turn off agent" = the Desktop Agent setting goes OFF (one on/off state;
  // the old separate hide-without-disabling preference is gone). The
  // localStorage write reaches the main webview's bridge via the storage
  // event and the bridge destroys the panel. The local turnedOff state
  // hides the avatar immediately while that close is in flight.
  const turnOff = useCallback(() => {
    gestureGeneration.current++;
    clearPress();
    if (machine.mode === "expanded") void collapse();
    if (machine.mode === "menu") void closeMenu();
    setTurnedOff(true);
    setDesktopAgentEnabled(false);
    void invoke("desktop_agent_close").catch(() => undefined);
  }, [clearPress, collapse, closeMenu]);

  // Right-click menu data/selection semantics (geometry is handled here
  // in openMenu/closeMenu): pick an agent for the NEXT chat (selection
  // creates nothing — deferred create on first send). Selection only
  // swaps the avatar; the popover stays closed until the user opens it.
  const avatarMenu = useAvatarMenu({
    pendingSelection: session.pendingSelection,
    activeAgentId: session.activeAgentId,
    select: session.select,
    agentSelector,
  });

  // Opens the custom webview menu: the collapsed window is avatar-sized,
  // so the panel grows first ("menu" mode — same anti-blink sequencing
  // as expand). Right-clicking while the chat is expanded CLOSES THE
  // CHAT FIRST and opens the menu from the collapsed state — the
  // simplest robust option (one grown-window layout at a time; no
  // menu-inside-chat z-order or geometry union to reason about).
  const openMenu = useCallback(async () => {
    if (openingMenu.current || machine.mode === "menu") return;
    if (machine.mode === "expanded") await collapse();
    if (machine.mode !== "avatar") return;
    const generation = ++gestureGeneration.current;
    openingMenu.current = true;
    try {
      const valid = () =>
        machine.mode === "avatar" &&
        generation === gestureGeneration.current &&
        !dropPending.current &&
        !dragging.current &&
        pointerDownAt.current === null;
      if (!valid()) return;
      const model = await avatarMenu.prepareMenu();
      if (!valid()) return;
      const size = menuOverlaySize({
        agentSelector,
        agentCount: model.agents.length,
      });
      const next = await machine.computeMenu(size);
      if (!valid()) return;
      setMenu({ layout: next, model });
      await machine.applyMenu(next);
    } finally {
      openingMenu.current = false;
    }
  }, [agentSelector, avatarMenu, collapse]);

  // Native perch follow refuses to resize an expanded/menu panel down to
  // avatar size; collapse first so the next tick can reseat safely.
  useEffect(() => {
    const unlisten = listen("desktop-agent:perch-moved", () => {
      gestureGeneration.current++;
      void closeMenu();
      void collapse();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [collapse, closeMenu]);

  // Key-loss while expanded = click outside -> collapse (menu included).
  useEffect(() => {
    const unlisten = listen<boolean>("desktop-agent:key-status", (event) => {
      // A late key-loss from openMenu's own collapse (or one landing while
      // already collapsed) must not cancel the menu that is opening.
      if (!event.payload) {
        if (machine.mode === "avatar" || openingMenu.current) return;
        gestureGeneration.current++;
        void closeMenu();
        void collapse();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [collapse, closeMenu]);

  // Esc closes the menu or collapses the popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      gestureGeneration.current++;
      void closeMenu();
      void collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapse, closeMenu]);

  // Global-shortcut toggle event from Rust (the registry-bound chord).
  // Only live while the panel exists (= setting enabled): hiding IS
  // disabling now, so there is no hidden-but-running panel.
  useEffect(() => {
    const unlisten = listen("desktop-agent:toggle-panel", () => {
      gestureGeneration.current++;
      if (machine.mode === "menu") void closeMenu();
      else if (machine.mode === "expanded") void collapse();
      else void expand();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [collapse, closeMenu, expand]);

  // Display connect/disconnect/rearrange: re-clamp the avatar onto a
  // visible screen (a disconnected display must not strand the panel).
  // Perched avatars are exempt — native perch placement owns the panel,
  // and the follow loop reconciles against the (possibly moved) window
  // on its next tick.
  useEffect(() => {
    const unlisten = listen("desktop-agent:screens-changed", () => {
      if (machine.mode === "avatar" && perch.phase === "unperched") {
        void machine.returnToSavedPosition();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [perch.phase]);

  const cancelPress = useCallback(() => {
    gestureGeneration.current++;
    ignoreNextClick.current = true;
    clearPress();
    if (dropPending.current) void perch.cancelTargeting();
    if (dragging.current) {
      dragging.current = false;
      dropPending.current = true;
      // Cancellation stops highlighting but must NEVER attach a perch.
      void perch.cancelTargeting().finally(() => {
        dropPending.current = false;
        setDragActive(false);
      });
    }
  }, [clearPress, perch.cancelTargeting]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: identity, renderer and visibility changes intentionally cancel the previous gesture via cleanup.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancelPress();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Clear hold/capture on identity changes, hiding and unmount, not on hover
    // or perch updates. Native drags can briefly lose key status, so no blur.
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancelPress();
    };
  }, [cancelPress, avatarAgentId, character, turnedOff]);

  const onAvatarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (turnedOff || e.button !== 0 || e.isPrimary === false || e.ctrlKey)
        return;
      ignoreNextClick.current = false;
      if (machine.mode !== "avatar" || pointerDownAt.current) return;
      // preventDefault before any native drag, or the webview turns the
      // gesture into text selection. Capture keeps stationary releases outside
      // the hit surface from leaving a stuck hold (native drag still uses slop).
      e.preventDefault();
      const press = {
        x: e.screenX,
        y: e.screenY,
        id: e.pointerId,
        element: e.currentTarget,
        held: false,
      };
      pointerDownAt.current = press;
      dragging.current = false;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // Native panel handoff may already have released the pointer.
      }
      if (character) {
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          if (pointerDownAt.current !== press || dragging.current) return;
          press.held = true;
          setHoldActive(true);
        }, HOLD_DELAY_MS);
      }
    },
    [character, turnedOff],
  );

  // Start native drag only on a fresh pointer-MOVE past slop. Queuing an old
  // event for later can teleport the AppKit panel after mouse-up.
  const onAvatarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = pointerDownAt.current;
      if (
        !start ||
        e.pointerId !== start.id ||
        dragging.current ||
        dropPending.current ||
        machine.mode !== "avatar"
      )
        return;
      const moved =
        Math.abs(e.screenX - start.x) > 3 || Math.abs(e.screenY - start.y) > 3;
      if (moved) {
        clearHoldTimer();
        dragging.current = true;
        setDragActive(true);
        // Only REAL movement detaches a host or begins permission-bearing
        // targeting; stationary holds remain purely visual, including perched.
        if (perch.phase !== "unperched") void perch.dismount();
        void machine.onDragStarted();
        void perch.beginTargeting();
      }
    },
    [clearHoldTimer, perch],
  );

  const onAvatarPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      const press = pointerDownAt.current;
      if (turnedOff || !press || e.pointerId !== press.id || e.button !== 0)
        return;
      const wasDragging = dragging.current;
      dragging.current = false;
      clearPress();
      // The collapsed pointer-up owns expansion/drag. Its following click must
      // not collapse the same persistent hit surface after layout changes.
      ignoreNextClick.current = true;
      if (wasDragging) {
        const generation = gestureGeneration.current;
        dropPending.current = true;
        try {
          const perched = await perch.endTargetingAndMaybePerch();
          if (generation !== gestureGeneration.current) return;
          if (perched) await machine.onDragEndedPerched();
          else await machine.onDragEnded();
        } finally {
          // Retain dangle throughout hit-test/attach; a newer stationary hold
          // has its own flag and cannot be cleared by this older completion.
          dropPending.current = false;
          setDragActive(false);
        }
      } else if (!press.held && !dropPending.current && !turnedOff) {
        await expand();
      }
    },
    [clearPress, turnedOff, expand, perch],
  );

  // Avatar follows the agent: pending selection previews the next chat's
  // identity (a pending fresh chat previews the default avatar by mapping
  // to null); otherwise the committed session binding; otherwise the
  // default avatar.

  const newChatBusy = useRef(false);
  const handleNewChat = useCallback(async () => {
    if (newChatBusy.current) return;
    newChatBusy.current = true;
    try {
      const armed = await avatarMenu.newChat(session.messages.length);
      if (!armed) return;
      await closeMenu();
      await expand({ composerOnly: true });
    } finally {
      newChatBusy.current = false;
    }
  }, [avatarMenu, closeMenu, expand, session.messages.length]);

  const activeLayout = layout ?? menu?.layout ?? null;
  const avatarRect = activeLayout?.avatarRect ?? lastAvatarRect;

  const avatarState = deriveAvatarState({
    hovering,
    expanded: layout !== null,
    connected: session.attached,
    activity: session.activity,
  });

  const avatarView = (
    <AgentAvatar
      character={character}
      choice={avatar.choice}
      state={avatarState}
      target={
        holdActive || dragActive || perch.phase === "targeting"
          ? "dangle"
          : perch.phase === "perched"
            ? "sit"
            : "idle"
      }
      hidden={turnedOff}
    />
  );

  if (!restored) return null;

  return (
    <div
      className="expanded-root"
      onPointerDown={(e) => {
        // Any press in the grown menu window outside the menu cards and
        // the avatar (shadow margin, empty corners) closes the menu.
        if (!menu) return;
        const target = e.target as Element;
        if (target.closest(".menu-card") || target.closest(".avatar-hit"))
          return;
        void closeMenu();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the avatar remains a div so pointer drag/capture stays on the native drag surface. */}
      <div
        ref={avatarTriggerRef}
        className="avatar-hit"
        style={{
          position: "absolute",
          left: avatarRect?.x ?? 0,
          top: avatarRect?.y ?? 0,
          width: avatarRect?.width ?? 94,
          height: avatarRect?.height ?? 94,
        }}
        onPointerDown={onAvatarPointerDown}
        onPointerMove={activeLayout ? undefined : onAvatarPointerMove}
        onPointerUp={activeLayout ? undefined : onAvatarPointerUp}
        onPointerCancel={(e) => {
          if (e.pointerId === pointerDownAt.current?.id) cancelPress();
        }}
        onLostPointerCapture={(e) => {
          // AppKit owns the pointer after performWindowDrag. Losing webview
          // capture alone is not cancellation of that native drag; pointer-up
          // still owns the drop, and pointercancel/hide remain explicit aborts.
          if (!dragging.current && e.pointerId === pointerDownAt.current?.id)
            cancelPress();
        }}
        onClick={(e) => {
          if (ignoreNextClick.current) {
            ignoreNextClick.current = false;
            return;
          }
          if (turnedOff || e.button !== 0) return;
          if (menu) void closeMenu({ restoreAvatarFocus: true });
          else if (layout) void collapse();
        }}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        title={t("avatar.title")}
        tabIndex={0}
        role="button"
        aria-label={t("avatar.title")}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onKeyDown={(e) => {
          if (turnedOff || e.repeat) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (menu) void closeMenu({ restoreAvatarFocus: true });
            else if (layout) void collapse();
            else void expand();
            return;
          }
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            void openMenu();
          }
        }}
        onContextMenu={(e) => {
          if (turnedOff) return;
          e.preventDefault();
          void openMenu();
        }}
      >
        {avatarView}
      </div>
      {layout && (
        <div
          className={`popover panel-popover${
            popoverVariant === "composer" ? " composer-mode" : ""
          }`}
          ref={popoverElement}
          style={{
            position: "absolute",
            left: layout.popoverRect.x,
            top: layout.popoverRect.y,
            width: layout.popoverRect.width,
            height: layout.popoverRect.height,
          }}
        >
          <ChatPopover
            session={session}
            perch={perch}
            variant={popoverVariant}
            anchor={
              layout.popoverSide === null
                ? layout.popoverAbove
                  ? "bottom"
                  : "top"
                : "center"
            }
            composerRef={composerElement}
          />
        </div>
      )}
      {menu && (
        <div
          style={{
            position: "absolute",
            left: menu.layout.popoverRect.x,
            top: menu.layout.popoverRect.y,
            width: menu.layout.popoverRect.width,
            height: menu.layout.popoverRect.height,
          }}
        >
          <AvatarMenu
            layout={menu.layout}
            agentSelector={agentSelector}
            model={menu.model}
            onNewChat={() => {
              void handleNewChat();
            }}
            onSelectAgent={(agent) => {
              avatarMenu.selectAgent(agent.agentId);
              void closeMenu({ restoreAvatarFocus: true });
            }}
            onSelectFresh={() => {
              avatarMenu.selectFresh();
              void closeMenu({ restoreAvatarFocus: true });
            }}
            onSettings={() => {
              // Rust reveals + focuses the main window and tells its
              // webview to open the Behavior settings section (where the
              // Desktop Agent settings live).
              void invoke("desktop_agent_open_settings").catch(() => undefined);
              void closeMenu();
            }}
            onTurnOff={turnOff}
            onClose={() => {
              void closeMenu({ restoreAvatarFocus: true });
            }}
          />
        </div>
      )}
    </div>
  );
}
