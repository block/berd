// Perch state hook: targeting rides the avatar drag, the drop attaches
// via desktop_agent_perch_on, the native follow loop owns panel position
// while perched, and perch-ended hands the shell an END REASON
// ("windowGone" flies the avatar home; "minimized" leaves it seated).
// Phases: unperched -> targeting (drag in flight) -> perched. Minimize
// AUTO-UNPERCHES (product rule): a minimized window is no longer clearly
// indicated on screen, and a silent grant invites accidental screenshot
// sends.
//
// Deliberately NOT persisted: perch identity. A perch is a context grant
// (window capture + artifact URL ride every send), so it must never
// re-establish itself across an app relaunch — re-perching costs one
// drag; an unnoticed auto-pin leaks screenshots. Dev-reload
// reconciliation stays: if the native side still holds a live perch
// across a webview reload, the grant never ended and the UI just
// re-syncs from desktop_agent_perch_status.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { PerchPhase } from "../lib/sendSource";

export interface PerchView {
  phase: PerchPhase;
  appName: string | null;
  title: string | null;
  /** Raw perch-layer error (AX resolve failure, capture failure, the
   *  accessibility_denied gate token). Kept verbatim — composerHint maps
   *  the recognized token to grant-instructions copy and renders the
   *  rest as-is. */
  lastError: string | null;
  /** Drag started: snapshot candidates, run the native highlight loop. */
  beginTargeting(): Promise<void>;
  /** Pointer-up: hit-test + attach. Returns true when a perch attached. */
  endTargetingAndMaybePerch(): Promise<boolean>;
  /** Cancel a gesture without attaching the hit-tested window. */
  cancelTargeting(): Promise<void>;
  dismount(): Promise<void>;
  /** Window-scoped capture of the perched window, or null when
   *  unperched/failed. Errors surface in lastError; sends degrade to
   *  text-only. */
  captureNow(): Promise<{ data: string; mimeType: string } | null>;
  /** Frontmost tab URL of the perched window, fresh per send (tabs
   *  change). Every failure is null — a send never blocks on this. */
  artifactUrlNow(): Promise<string | null>;
}

/** Why a native perch ended without a dismount gesture. */
export type PerchEndReason = "windowGone" | "minimized";

export function usePerch(
  onPerchEnded: (reason: PerchEndReason) => void,
  characterSeat = false,
): PerchView {
  const [phase, setPhase] = useState<PerchPhase>("unperched");
  const [appName, setAppName] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const targetingGeneration = useRef(0);
  const endedHandler = useRef(onPerchEnded);
  endedHandler.current = onPerchEnded;

  // Startup — ONE effect, strictly ordered (listen() is async, so a
  // native perch event could otherwise outrun its listener):
  //   1. AWAIT the perch-ended listener
  //   2. reconcile native state (dev-reload only — no startup rematch)
  useEffect(() => {
    let cancelled = false;
    let unlistenEnded: (() => void) | null = null;
    void (async () => {
      // 1. Listener FIRST — no native event may outrun it. The payload
      // is the END REASON: "windowGone" (closed — avatar flies home) vs
      // "minimized" (auto-unperch — the avatar STAYS where it was
      // seated; a minimize is not a close, and yanking the avatar home
      // would punish the gesture).
      unlistenEnded = await listen<string>(
        "desktop-agent:perch-ended",
        (event) => {
          setPhase("unperched");
          setAppName(null);
          setTitle(null);
          endedHandler.current(
            event.payload === "minimized" ? "minimized" : "windowGone",
          );
        },
      );
      if (cancelled) {
        unlistenEnded();
        return;
      }

      // 2. Reconcile native state (dev-reload only: a webview reload
      // does not end the grant — the native perch never stopped). A full
      // app relaunch always starts unperched by design.
      try {
        const status = await invoke<{
          perched: boolean;
          appName: string | null;
          title: string | null;
        }>("desktop_agent_perch_status");
        if (cancelled) return;
        if (status.perched) {
          setPhase("perched");
          setAppName(status.appName);
          setTitle(status.title);
        }
      } catch {
        // Reconciliation is best-effort; the avatar stays free.
      }
    })();
    return () => {
      cancelled = true;
      unlistenEnded?.();
    };
  }, []);

  // Re-seat an existing grant when the renderer changes; never request
  // permission or attach a new grant from this effect.
  useEffect(() => {
    void invoke("desktop_agent_perch_status", { characterSeat }).catch(
      () => {},
    );
  }, [characterSeat]);

  const beginTargeting = useCallback(async () => {
    const generation = ++targetingGeneration.current;
    setPhase("targeting");
    try {
      await invoke("desktop_agent_perch_begin_targeting");
    } catch (error) {
      if (generation !== targetingGeneration.current) return;
      setLastError(String(error));
      setPhase("unperched");
    }
  }, []);

  const endTargetingAndMaybePerch = useCallback(async (): Promise<boolean> => {
    const generation = targetingGeneration.current;
    try {
      const candidate = await invoke<{
        appName: string;
        title: string;
      } | null>("desktop_agent_perch_end_targeting");
      if (generation !== targetingGeneration.current) return false;
      if (!candidate) {
        setPhase("unperched");
        return false;
      }
      const result = await invoke<{ appName: string; title: string }>(
        "desktop_agent_perch_on",
        { characterSeat },
      );
      if (generation !== targetingGeneration.current) {
        // Cancellation can arrive while native attach is already in flight.
        await invoke("desktop_agent_perch_dismount");
        return false;
      }
      setPhase("perched");
      setAppName(result.appName);
      setTitle(result.title);
      setLastError(null);
      return true;
    } catch (error) {
      if (generation !== targetingGeneration.current) return false;
      setLastError(String(error));
      setPhase("unperched");
      return false;
    }
  }, [characterSeat]);

  const cancelTargeting = useCallback(async () => {
    targetingGeneration.current++;
    setPhase("unperched");
    // Stop the native highlight loop and discard its candidate. In particular,
    // cancellation must not call perch_on (which can request permissions).
    try {
      await invoke("desktop_agent_perch_end_targeting");
    } catch {
      // Cancellation is best-effort when the native panel is disappearing.
    }
  }, []);

  const dismount = useCallback(async () => {
    try {
      await invoke("desktop_agent_perch_dismount");
    } finally {
      setPhase("unperched");
      setAppName(null);
      setTitle(null);
    }
  }, []);

  const captureNow = useCallback(async () => {
    if (phase === "unperched" || phase === "targeting") return null;
    try {
      return await invoke<{ data: string; mimeType: string } | null>(
        "desktop_agent_perch_capture",
      );
    } catch (error) {
      // Capture failure never blocks a send — it degrades to text-only.
      setLastError(String(error));
      return null;
    }
  }, [phase]);

  const artifactUrlNow = useCallback(async () => {
    if (phase === "unperched" || phase === "targeting") return null;
    try {
      return await invoke<string | null>("desktop_agent_perch_artifact_url");
    } catch {
      return null;
    }
  }, [phase]);

  return {
    phase,
    appName,
    title,
    lastError,
    beginTargeting,
    endTargetingAndMaybePerch,
    cancelTargeting,
    dismount,
    captureNow,
    artifactUrlNow,
  };
}
