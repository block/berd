import { useEffect, useRef, useState } from "react";

import type { BerdyPose } from "@/features/desktop-agent/lib/berdyClips";
import { BerdyMachine } from "@/features/desktop-agent/lib/berdyMachine";

export function BerdyView({
  target,
  errored,
  hidden,
  size,
  onReady,
}: {
  target: BerdyPose;
  errored: boolean;
  hidden: boolean;
  size: number;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const machineRef = useRef<BerdyMachine | null>(null);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const latest = useRef({ target, errored, hidden, onReady });
  latest.current = { target, errored, hidden, onReady };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (reducedMotion || !canvasRef.current) return;
    setReady(false);
    const machine = new BerdyMachine({
      canvas: canvasRef.current,
      onReady: () => {
        setReady(true);
        latest.current.onReady?.();
      },
    });
    machineRef.current = machine;
    machine.setTarget(latest.current.target);
    const sync = () => {
      if (
        latest.current.errored ||
        latest.current.hidden ||
        document.visibilityState === "hidden"
      )
        machine.suspend();
      else machine.resume();
    };
    sync();
    machine.start();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      machine.dispose();
      machineRef.current = null;
    };
  }, [reducedMotion]);

  useEffect(() => {
    machineRef.current?.setTarget(target);
  }, [target]);
  useEffect(() => {
    const machine = machineRef.current;
    if (errored || hidden || document.visibilityState === "hidden")
      machine?.suspend();
    else machine?.resume();
  }, [errored, hidden]);

  const style = {
    width: size,
    height: size,
    filter: errored ? "grayscale(1) brightness(0.7)" : "none",
  };
  if (reducedMotion)
    return (
      <img
        src="/desktop-agent/berdy/berdy_Idle_01_00001_.png"
        alt=""
        draggable={false}
        style={style}
        onLoad={() => latest.current.onReady?.()}
      />
    );
  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={400}
      style={{ ...style, opacity: ready ? 1 : 0 }}
    />
  );
}
