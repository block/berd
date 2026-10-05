// Avatar chip: looping HEVC video with per-state treatment (ported from
// the prototype's avatar_view.dart). No rings or overlays — the animation itself is
// the avatar. While the video initializes the chip stays invisible (no
// placeholder flash); the prototype's flash-free swap rule carries over: the old
// source keeps playing until the new one is ready.

import { useEffect, useRef, useState } from "react";

import {
  cornerRadius,
  treatmentFor,
  type AvatarChoice,
  type AvatarState,
} from "../lib/avatarState";

export function AvatarView({
  choice,
  state,
  size,
  onReady,
}: {
  choice: AvatarChoice;
  state: AvatarState;
  size: number;
  onReady?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);
  // Flash-free swap: keep rendering the previous src until the new one is
  // ready. Two media elements never render at once — the src only advances
  // when the probe confirms it decodable (browser keeps painting the old
  // frame until then; the single-element swap is imperceptible at chip size).
  // The ACTIVE kind rides along: during a video->image swap the displayed
  // element must stay a <video> until the image is ready.
  const [active, setActive] = useState({ src: choice.src, kind: choice.kind });

  useEffect(() => {
    if (choice.src === active.src) return;
    const next = { src: choice.src, kind: choice.kind };
    // Probe matches the media kind of the INCOMING source.
    if (choice.kind === "image") {
      const probe = new Image();
      probe.src = choice.src;
      probe.onload = () => setActive(next);
      probe.onerror = () => setActive(next); // visible failure beats a stuck chip
      return () => {
        probe.onload = null;
        probe.onerror = null;
      };
    }
    const probe = document.createElement("video");
    probe.muted = true;
    probe.src = choice.src;
    probe.oncanplay = () => setActive(next);
    probe.onerror = () => setActive(next); // fall through; visible failure beats a stuck chip
    probe.load();
    return () => {
      probe.oncanplay = null;
      probe.onerror = null;
    };
  }, [choice.src, choice.kind, active.src]);

  const treatment = treatmentFor(state);

  // Apply playback treatment whenever state or the element changes.
  // Static images have no playback — scale/desaturation still apply via
  // the chip style below.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready || active.kind !== "video") return;
    video.playbackRate = treatment.playbackRate;
    if (treatment.paused) {
      video.pause();
    } else if (video.paused) {
      void video.play().catch(() => {});
    }
  }, [treatment.playbackRate, treatment.paused, ready, active]);

  // Frozen-avatar fix: WKWebView pauses <video> EXTERNALLY when the
  // panel hides or is occluded (the showAgent hide, occlusion). The
  // treatment effect above only re-runs when its deps change — and the
  // common transitions (hover↔idle, expanded↔collapsed) all keep
  // playbackRate=1.0/paused=false, so an external pause stuck forever
  // (only incidentally cured when a send flipped thinking's 1.6 rate).
  // Two re-assertion paths, both no-ops for a legitimate error-state
  // pause (treatment.paused reads the CURRENT treatment via ref):
  const treatmentRef = useRef(treatment);
  treatmentRef.current = treatment;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready || active.kind !== "video") return;
    // 1. The element itself reports the muzzle: an external pause fires
    //    `pause` — resume unless the treatment genuinely wants a pause.
    const onPause = () => {
      if (!treatmentRef.current.paused) void video.play().catch(() => {});
    };
    // 2. Belt-and-suspenders: on becoming visible again, re-assert the
    //    full treatment (some WKWebView pauses land without a pause
    //    event reaching JS).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      video.playbackRate = treatmentRef.current.playbackRate;
      if (!treatmentRef.current.paused && video.paused) {
        void video.play().catch(() => {});
      }
    };
    video.addEventListener("pause", onPause);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      video.removeEventListener("pause", onPause);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, active]);

  // Stall watchdog (hide/show alone did NOT cure a frozen loop in the
  // field, so the pause-event/visibility paths above can miss). WKWebView
  // has a further failure mode: the video reports paused=false but the
  // decoder is suspended — no pause event, no visibility change, frozen
  // frames. Poll currentTime; if it stops advancing while the treatment
  // wants motion, nudge (seek + play), then fully re-init the decoder
  // (load) as the last resort. Steady state is one cheap property read
  // per tick.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready || active.kind !== "video") return;
    let last = -1;
    let stalledTicks = 0;
    const id = window.setInterval(() => {
      if (treatmentRef.current.paused) {
        last = -1;
        stalledTicks = 0;
        return; // error state: frozen is correct
      }
      const now = video.currentTime;
      if (now !== last) {
        last = now;
        stalledTicks = 0;
        return; // advancing: healthy
      }
      stalledTicks += 1;
      if (stalledTicks <= 2) {
        // Gentle kick: a micro-seek forces a decode; play() covers the
        // silently-paused variant.
        try {
          video.currentTime = now + 0.01;
        } catch {
          /* seek can throw pre-metadata; the next tick escalates */
        }
        void video.play().catch(() => {});
      } else if (stalledTicks === 3) {
        // Decoder re-init. loop/muted/autoplay attributes persist; the
        // existing onCanPlay handler re-fires. ready stays true — the
        // brief re-buffer beats an eternally frozen avatar.
        video.load();
        void video.play().catch(() => {});
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [ready, active]);

  // Per-avatar render scale: shrinks the CHIP only. The hit target and
  // panel frame stay full size (the flex-centered parent absorbs the
  // difference), so drag/click/perch geometry is unchanged.
  const rendered = size * (choice.renderScale ?? 1);

  return (
    <div
      className="avatar-chip"
      style={{
        width: rendered,
        height: rendered,
        borderRadius: cornerRadius(choice.shape, rendered),
        overflow: "hidden",
        transform: `scale(${treatment.scale})`,
        transition: "transform 140ms ease, filter 220ms ease",
        filter: treatment.desaturated ? "grayscale(1) brightness(0.7)" : "none",
        opacity: ready ? 1 : 0,
      }}
    >
      {active.kind === "image" ? (
        <img
          key={active.src}
          src={active.src}
          alt=""
          draggable={false}
          onLoad={() => setReady(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <video
          ref={videoRef}
          key={active.src}
          src={active.src}
          muted
          loop
          autoPlay
          playsInline
          onCanPlay={() => setReady(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
    </div>
  );
}
