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

import type { ExpandedLayout } from "../lib/anchorGeometry";
import { deriveAvatarState } from "../lib/avatarState";
import {
  getDesktopAgentVisible,
  setDesktopAgentVisible,
  useDesktopAgentVisiblePreference,
} from "../lib/desktopAgentPreferences";
import { PanelStateMachine } from "../lib/panelState";
import {
  LocalStoragePositionStore,
  TauriWindowPort,
} from "../lib/tauriWindowPort";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { useAvatarMenu } from "../hooks/useAvatarMenu";
import { usePerch } from "../hooks/usePerch";
import { useSession } from "../hooks/useSession";
import { AgentAvatar } from "./AgentAvatar";
import { ChatPopover } from "./ChatPopover";
import "./desktop-agent.css";

// Distinguish an intentional stationary hold from an ordinary chat click.
const HOLD_DELAY_MS = 180;

const machine = new PanelStateMachine({
  window: new TauriWindowPort(),
  positionStore: new LocalStoragePositionStore(),
});

export function DesktopAgentApp() {
  const { t } = useTranslation("desktop-agent");
  const session = useSession();
  const agentSelector =
    useExperiment(DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID)?.enabled === true;
  const visible = useDesktopAgentVisiblePreference().enabled;
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
  const [hovering, setHovering] = useState(false);
  const [restored, setRestored] = useState(false);
  const collapsing = useRef(false);
  const dragging = useRef(false);
  const ignoreNextClick = useRef(false);
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
    if (collapsing.current || machine.mode !== "expanded") return;
    collapsing.current = true;
    try {
      // Anti-blink: drop the popover from the tree BEFORE the native
      // shrink, so the resize repaint never shows a stale popover.
      setLayout(null);
      await machine.collapse();
    } finally {
      collapsing.current = false;
    }
  }, []);

  const expand = useCallback(async () => {
    if (machine.mode !== "avatar") return;
    // Anti-blink: compute first, commit to the tree, THEN resize native.
    const next = await machine.computeExpanded();
    setLayout(next);
    await machine.applyExpanded(next);
  }, []);

  // Right-click "Hide Desktop Agent": same as turning off the "Show the
  // agent" setting (chat kept; the toggle chord resurrects it — see the
  // toggle-panel listener). The localStorage write reaches the main
  // webview's bridge via the storage event; the direct set_visible hides
  // immediately even if that webview is reloading (idempotent with the
  // bridge's own call).
  // Any in-flight press is cancelled by the showAgent-keyed gesture
  // cleanup effect below.
  const dismiss = useCallback(() => {
    if (machine.mode === "expanded") void collapse();
    setDesktopAgentVisible(false);
    void invoke("desktop_agent_set_visible", { visible: false }).catch(
      () => undefined,
    );
  }, [collapse]);

  // Right-click menu: pick an agent for the NEXT chat (selection creates
  // nothing — deferred create on first send). Selection only swaps the
  // avatar; the popover stays closed until the user opens it.
  const avatarMenu = useAvatarMenu({
    pendingSelection: session.pendingSelection,
    activeAgentId: session.activeAgentId,
    select: session.select,
    agentSelector,
    dismiss,
  });

  // Key-loss while expanded = click outside -> collapse.
  useEffect(() => {
    const unlisten = listen<boolean>("desktop-agent:key-status", (event) => {
      if (!event.payload) void collapse();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [collapse]);

  // Esc collapses the popover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      void collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapse]);

  // Global-shortcut toggle event from Rust (the registry-bound chord).
  useEffect(() => {
    const unlisten = listen("desktop-agent:toggle-panel", () => {
      // The chord resurrects a hidden panel (a dead shortcut while hidden
      // would feel broken). showAgent lives in localStorage, which is
      // shared across same-origin webviews: writing it true here fires
      // the storage event in the MAIN webview, whose bridge orders the
      // panel front — and the settings toggle reflects reality. Skip the
      // popover toggle on resurrect; the next press toggles normally.
      if (!getDesktopAgentVisible()) {
        setDesktopAgentVisible(true);
        return;
      }
      if (machine.mode === "expanded") void collapse();
      else void expand();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [collapse, expand]);

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
  }, [cancelPress, avatarAgentId, character, visible]);

  const onAvatarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || e.isPrimary === false) return;
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
    [character],
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
      if (!press || e.pointerId !== press.id || e.button !== 0) return;
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
      } else if (!press.held && !dropPending.current) {
        await expand();
      }
    },
    [clearPress, expand, perch],
  );

  // Avatar follows the agent: pending selection previews the next chat's
  // identity (a pending fresh chat previews the default avatar by mapping
  // to null); otherwise the committed session binding; otherwise the
  // default avatar.

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
      hidden={!visible}
    />
  );

  if (!restored) return null;

  return (
    <div className="expanded-root">
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the avatar is a pointer-driven native-drag surface (performWindowDrag), not a semantic control — keyboard access is the global toggle shortcut */}
      <div
        className="avatar-hit"
        style={{
          position: "absolute",
          left: layout?.avatarRect.x ?? 0,
          top: layout?.avatarRect.y ?? 0,
          width: layout?.avatarRect.width ?? 94,
          height: layout?.avatarRect.height ?? 94,
        }}
        onPointerDown={onAvatarPointerDown}
        onPointerMove={layout ? undefined : onAvatarPointerMove}
        onPointerUp={layout ? undefined : onAvatarPointerUp}
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
          if (layout && e.button === 0) void collapse();
        }}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        title={t("avatar.title")}
        onContextMenu={(e) => {
          e.preventDefault();
          void avatarMenu.openMenu();
        }}
      >
        {avatarView}
      </div>
      {layout && (
        <div
          className="popover panel-popover"
          style={{
            position: "absolute",
            left: layout.popoverRect.x,
            top: layout.popoverRect.y,
            width: layout.popoverRect.width,
            height: layout.popoverRect.height,
          }}
        >
          <ChatPopover session={session} perch={perch} />
        </div>
      )}
    </div>
  );
}
