import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { resetCardTilt, updateCardTilt } from "./cardTilt";

export type HolographicFinish = "metallic" | "holographic" | "prismatic";

export interface HolographicCardSettings {
  finish: HolographicFinish;
  metalness: number;
  rainbow: number;
  glare: number;
  grain: number;
  diffraction: number;
  speed: number;
  tilt: number;
}

export interface HolographicAgentCardProps {
  src: string;
  alt: string;
  children?: ReactNode;
  className?: string;
  settings?: HolographicCardSettings;
  /** Preserve the source artwork's exact proportions when showing imports. */
  aspectRatio?: number;
  /** Constrain extreme imported proportions without cropping their pixels. */
  containArtwork?: boolean;
  /** Optional agent-derived color used to tint the card's ambient shadow. */
  shadowColor?: string;
  /** Optional agent-derived color applied to the card's foil frame. */
  tintColor?: string;
  /** Restrict the animated foil to the frame when artwork already contains its content panel. */
  frameOnly?: boolean;
}

export const holographicCardPresets = {
  polishedAlloy: {
    finish: "metallic",
    metalness: 84,
    rainbow: 18,
    glare: 64,
    grain: 18,
    diffraction: 24,
    speed: 18,
    tilt: 9,
  },
  rainbowPrism: {
    finish: "prismatic",
    metalness: 30,
    rainbow: 72,
    glare: 72,
    grain: 14,
    diffraction: 80,
    speed: 20,
    tilt: 8,
  },
} as const satisfies Record<string, HolographicCardSettings>;

const vertexShader = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;

  uniform sampler2D uTexture;
  uniform vec2 uPointer;
  uniform float uTime;
  uniform float uMetalness;
  uniform float uRainbow;
  uniform float uGlare;
  uniform float uGrain;
  uniform float uDiffraction;
  uniform float uMode;
  varying vec2 vUv;

  float random(vec2 point) {
    return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec4 source = texture2D(uTexture, vUv);
    vec3 color = source.rgb;
    float luminance = dot(color, vec3(0.299, 0.587, 0.114));

    vec2 lightCenter = vec2(0.5) + uPointer * 0.28;
    vec2 delta = vUv - lightCenter;
    float diagonal = dot(delta, normalize(vec2(0.78, 0.62)));
    float glareBand = pow(max(0.0, 1.0 - abs(diagonal) * 3.7), 5.0);
    float bloom = pow(max(0.0, 1.0 - length(delta) * 1.42), 4.0);

    float phase =
      vUv.x * (2.1 + uDiffraction * 4.2) +
      vUv.y * (1.3 + uDiffraction * 2.7) +
      uPointer.x * 0.72 -
      uPointer.y * 0.46 +
      uTime;
    vec3 spectrum = 0.54 + 0.46 * cos(
      6.2831853 * (phase + vec3(0.0, 0.34, 0.67))
    );

    float foilMask = 0.24 + smoothstep(0.12, 0.92, luminance) * 0.76;
    float edge = smoothstep(0.72, 0.02, min(
      min(vUv.x, 1.0 - vUv.x),
      min(vUv.y, 1.0 - vUv.y)
    ));
    vec3 silver = mix(vec3(luminance), color, 0.28);
    silver *= vec3(0.93, 0.98, 1.05);
    color = mix(color, silver, uMetalness * (0.26 + glareBand * 0.3));

    float holoAmount = uMode > 0.5 ? uRainbow : uRainbow * 0.22;
    float prismBoost = uMode > 1.5 ? 1.34 : 1.0;
    color += spectrum * (glareBand * 0.74 + bloom * 0.2) * holoAmount * foilMask * prismBoost;
    color += vec3(1.0, 0.97, 0.9) * glareBand * uGlare * (0.22 + luminance * 0.38);
    color += spectrum * edge * holoAmount * 0.12;

    float microGrain = random(vUv * vec2(1431.0, 2003.0) + uTime) - 0.5;
    color += microGrain * uGrain * 0.11;
    color = pow(max(color, 0.0), vec3(0.96));

    gl_FragColor = vec4(color, source.a);
  }
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function HolographicAgentCard({
  src,
  alt,
  children,
  className,
  settings = holographicCardPresets.rainbowPrism,
  aspectRatio,
  containArtwork = false,
  shadowColor,
  tintColor,
  frameOnly = false,
}: HolographicAgentCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const patternId = `agent-card-wave-${useId().replaceAll(":", "")}`;
  const [contextGeneration, setContextGeneration] = useState(0);
  const pointer = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const hoverBoundsRef = useRef<DOMRect | null>(null);
  const settingsRef = useRef<HolographicCardSettings>(settings);
  const startAnimationRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    settingsRef.current = settings;
    startAnimationRef.current();
  }, [settings]);

  useEffect(() => {
    // Re-run initialization after the browser restores a lost WebGL context.
    void contextGeneration;
    const canvas = canvasRef.current;
    const card = cardRef.current;
    if (!canvas || !card || !("WebGLRenderingContext" in window)) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    if (!gl) return;

    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShader);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShader);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return;
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return;
    }
    const activateProgram = gl.useProgram.bind(gl);
    activateProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

    const image = new Image();
    let imageReady = false;
    let animationRunning = false;
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      imageReady = true;
      startAnimation();
    };
    image.src = src;

    const uniforms = {
      pointer: gl.getUniformLocation(program, "uPointer"),
      time: gl.getUniformLocation(program, "uTime"),
      metalness: gl.getUniformLocation(program, "uMetalness"),
      rainbow: gl.getUniformLocation(program, "uRainbow"),
      glare: gl.getUniformLocation(program, "uGlare"),
      grain: gl.getUniformLocation(program, "uGrain"),
      diffraction: gl.getUniformLocation(program, "uDiffraction"),
      mode: gl.getUniformLocation(program, "uMode"),
    };
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    let foilPhase = 0;

    const render = () => {
      animationRunning = false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const displayWidth = Math.round(canvas.clientWidth * dpr);
      const displayHeight = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);

      const previousX = pointer.current.x;
      const previousY = pointer.current.y;
      pointer.current.x += (target.current.x - pointer.current.x) * 0.22;
      pointer.current.y += (target.current.y - pointer.current.y) * 0.22;

      const current = settingsRef.current;
      const movement = Math.hypot(
        pointer.current.x - previousX,
        pointer.current.y - previousY,
      );
      if (!reducedMotion && movement > 0.0004) {
        foilPhase += movement * (0.18 + current.speed / 55);
      }

      const mode =
        current.finish === "metallic"
          ? 0
          : current.finish === "holographic"
            ? 1
            : 2;

      if (imageReady) {
        gl.uniform2f(uniforms.pointer, pointer.current.x, pointer.current.y);
        gl.uniform1f(uniforms.time, reducedMotion ? 0 : foilPhase);
        gl.uniform1f(uniforms.metalness, current.metalness / 100);
        gl.uniform1f(uniforms.rainbow, current.rainbow / 100);
        gl.uniform1f(uniforms.glare, current.glare / 100);
        gl.uniform1f(uniforms.grain, current.grain / 100);
        gl.uniform1f(uniforms.diffraction, current.diffraction / 100);
        gl.uniform1f(uniforms.mode, mode);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // Physical tilt is owned by the shared pointer helper on every surface.
      // The frame loop only eases holographic lighting toward that pointer.
      if (reducedMotion) card.style.transform = "none";
      const unsettled =
        Math.abs(target.current.x - pointer.current.x) > 0.0004 ||
        Math.abs(target.current.y - pointer.current.y) > 0.0004;
      if (!reducedMotion && unsettled) startAnimation();
    };
    function startAnimation() {
      if (animationRunning) return;
      animationRunning = true;
      frame = requestAnimationFrame(render);
    }
    startAnimationRef.current = startAnimation;
    startAnimation();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
    };
    const handleContextRestored = () => {
      setContextGeneration((generation) => generation + 1);
    };
    const handlePointerTargetChange = () => {
      if (!reducedMotion) startAnimation();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    card.addEventListener("holographic-card-move", handlePointerTargetChange);

    return () => {
      startAnimationRef.current = () => undefined;
      cancelAnimationFrame(frame);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      card.removeEventListener(
        "holographic-card-move",
        handlePointerTargetChange,
      );
      image.onload = null;
      image.removeAttribute("src");
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, [contextGeneration, src]);

  return (
    <div
      ref={cardRef}
      data-agent-card-surface="true"
      className={cn(
        "relative aspect-[1227/1839] w-full rounded-[6.5%] [transform-origin:50%_50%] [transform-style:preserve-3d] [will-change:transform] motion-reduce:transform-none",
        className,
      )}
      style={{
        ...(aspectRatio && !containArtwork ? { aspectRatio } : {}),
        borderRadius: "6.5%",
        filter: shadowColor
          ? `drop-shadow(0 12px 18px color-mix(in srgb, ${shadowColor} 12%, transparent)) drop-shadow(0 4px 7px rgba(46, 32, 18, 0.08))`
          : "drop-shadow(0 10px 16px rgba(46, 32, 18, 0.1))",
      }}
      onPointerEnter={(event) => {
        hoverBoundsRef.current = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-local-x",
          `${event.nativeEvent.offsetX}px`,
        );
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-local-y",
          `${event.nativeEvent.offsetY}px`,
        );
        const localX = event.nativeEvent.offsetX;
        const localY = event.nativeEvent.offsetY;
        if (
          Number.isFinite(localX) &&
          Number.isFinite(localY) &&
          event.currentTarget.clientWidth > 0 &&
          event.currentTarget.clientHeight > 0
        ) {
          event.currentTarget.style.setProperty(
            "--agent-card-pattern-svg-x",
            `${(localX / event.currentTarget.clientWidth) * 1227}`,
          );
          event.currentTarget.style.setProperty(
            "--agent-card-pattern-svg-y",
            `${(localY / event.currentTarget.clientHeight) * 1839}`,
          );
        }
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-opacity",
          "0.52",
        );
      }}
      onPointerMove={(event) => {
        // Re-read bounds after every tilt. The transformed card's client rect
        // changes as it rotates, so enter-time bounds make cursor effects lag
        // behind or drift away from the pointer.
        const measuredBounds = event.currentTarget.getBoundingClientRect();
        const bounds =
          measuredBounds.width > 0 && measuredBounds.height > 0
            ? measuredBounds
            : hoverBoundsRef.current;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
        hoverBoundsRef.current = bounds;
        target.current = {
          x: ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
          y: ((event.clientY - bounds.top) / bounds.height - 0.5) * 2,
        };
        // Use local pixels from the transformed hit target. Percentages derived from
        // an axis-aligned bounding box drift as the card rotates in 3D.
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-local-x",
          `${event.nativeEvent.offsetX}px`,
        );
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-local-y",
          `${event.nativeEvent.offsetY}px`,
        );
        const localX = event.nativeEvent.offsetX;
        const localY = event.nativeEvent.offsetY;
        if (
          Number.isFinite(localX) &&
          Number.isFinite(localY) &&
          event.currentTarget.clientWidth > 0 &&
          event.currentTarget.clientHeight > 0
        ) {
          event.currentTarget.style.setProperty(
            "--agent-card-pattern-svg-x",
            `${(localX / event.currentTarget.clientWidth) * 1227}`,
          );
          event.currentTarget.style.setProperty(
            "--agent-card-pattern-svg-y",
            `${(localY / event.currentTarget.clientHeight) * 1839}`,
          );
        }
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-opacity",
          "0.52",
        );
        updateCardTilt(
          event.currentTarget,
          event,
          settingsRef.current.tilt,
          bounds,
        );
        cardRef.current?.dispatchEvent(new Event("holographic-card-move"));
      }}
      onPointerLeave={(event) => {
        hoverBoundsRef.current = null;
        target.current = { x: 0, y: 0 };
        event.currentTarget.style.removeProperty(
          "--agent-card-pattern-local-x",
        );
        event.currentTarget.style.removeProperty(
          "--agent-card-pattern-local-y",
        );
        event.currentTarget.style.removeProperty("--agent-card-pattern-svg-x");
        event.currentTarget.style.removeProperty("--agent-card-pattern-svg-y");
        event.currentTarget.style.setProperty(
          "--agent-card-pattern-opacity",
          "0",
        );
        resetCardTilt(event.currentTarget);
        event.currentTarget.dispatchEvent(new Event("holographic-card-move"));
      }}
    >
      <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
        <img
          src={src}
          alt={alt}
          className={cn(
            "absolute inset-0 block h-full w-full",
            containArtwork ? "object-contain" : "object-cover",
          )}
        />
        <canvas
          ref={canvasRef}
          data-agent-card-frame-only={frameOnly ? "true" : undefined}
          className="absolute inset-0 block h-full w-full opacity-90"
          style={
            frameOnly
              ? {
                  WebkitMaskImage:
                    "linear-gradient(black, black), linear-gradient(black, black)",
                  WebkitMaskPosition: "center, center",
                  WebkitMaskSize: "100% 100%, 95.1% 96.6%",
                  WebkitMaskRepeat: "no-repeat, no-repeat",
                  WebkitMaskComposite: "xor",
                  maskImage:
                    "linear-gradient(black, black), linear-gradient(black, black)",
                  maskPosition: "center, center",
                  maskSize: "100% 100%, 95.1% 96.6%",
                  maskRepeat: "no-repeat, no-repeat",
                  maskComposite: "exclude",
                }
              : undefined
          }
        />
        {tintColor ? (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[inherit] border-[7px]"
              style={{
                borderColor: tintColor,
                mixBlendMode: "color",
                opacity: 0.34,
              }}
            />
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-[3] size-full opacity-[var(--agent-card-pattern-opacity,0)] transition-opacity duration-150 motion-reduce:hidden"
              viewBox="0 0 1227 1839"
            >
              <defs>
                <pattern
                  id={`${patternId}-waves`}
                  width="160"
                  height="96"
                  patternUnits="userSpaceOnUse"
                >
                  <g fill="none" stroke={tintColor} strokeWidth="1.4">
                    {[8, 20, 32, 44, 56, 68, 80, 92].map((y) => (
                      <path
                        key={y}
                        d={`M-40 ${y} C-20 ${y - 12} 0 ${y - 12} 20 ${y} S60 ${y + 12} 80 ${y} S120 ${y - 12} 140 ${y} S180 ${y + 12} 200 ${y}`}
                      />
                    ))}
                  </g>
                </pattern>
                <radialGradient id={`${patternId}-reveal`}>
                  <stop offset="0" stopColor="white" stopOpacity="1" />
                  <stop offset="0.35" stopColor="white" stopOpacity="0.82" />
                  <stop offset="0.7" stopColor="white" stopOpacity="0.25" />
                  <stop offset="1" stopColor="white" stopOpacity="0" />
                </radialGradient>
                <mask id={`${patternId}-mask`} maskUnits="userSpaceOnUse">
                  <circle
                    cx="var(--agent-card-pattern-svg-x, -500)"
                    cy="var(--agent-card-pattern-svg-y, -500)"
                    r="330"
                    fill={`url(#${patternId}-reveal)`}
                  />
                </mask>
              </defs>
              <rect
                x="30"
                y="31"
                width="1167"
                height="1777"
                rx="70"
                fill={`url(#${patternId}-waves)`}
                mask={`url(#${patternId}-mask)`}
              />
            </svg>
          </>
        ) : null}
        {children ? (
          <div className="pointer-events-none absolute inset-0 z-10">
            {children}
          </div>
        ) : null}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] border border-white/70 shadow-[inset_0_0_0_2px_rgba(255,255,255,0.15),inset_0_0_28px_rgba(255,255,255,0.12)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,transparent_30%,rgba(255,255,255,0.12)_45%,transparent_61%)] mix-blend-screen"
        />
      </div>
    </div>
  );
}
