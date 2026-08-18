import {
  Suspense,
  useCallback,
  type ComponentRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Canvas,
  type ThreeEvent,
  useFrame,
  useThree,
} from "@react-three/fiber";
import {
  Environment,
  MeshTransmissionMaterial,
  OrbitControls,
  useGLTF,
  useTexture,
} from "@react-three/drei";
import * as THREE from "three";
import { cn } from "@/shared/lib/cn";
import { PROJECT_ARTIFACT_CUBE_MODEL_URL } from "./assets";
import {
  applyProjectArtifactCubeTexture,
  disposeProjectArtifactCubeMaterials,
} from "./projectArtifactThreeResources";
import { useRenderWindowVisible } from "./renderVisibility";
import type {
  ProjectArtifactContentMode,
  ProjectArtifactRendererProps,
  ProjectArtifactState,
} from "./types";

interface CubeGltf {
  nodes: Record<string, THREE.Mesh>;
}

interface CameraAngles {
  azimuth: number;
  polar: number;
}

interface ArtifactRuntimeState {
  clickPulse: number;
  contentTransition: number;
  cursorPosition: { x: number; y: number };
  dragVelocity: number;
  imageIndex: number;
  isDragging: boolean;
  isHovered: boolean;
  isIdle: boolean;
  isPointerDown: boolean;
  isTransitioning: boolean;
  lastInteractionTime: number;
}

type ArtifactRuntimeRef = MutableRefObject<ArtifactRuntimeState>;
type CameraAnglesRef = MutableRefObject<CameraAngles>;
type TextureList = THREE.Texture[];
type CubePointerEvent = ThreeEvent<PointerEvent>;

interface TransmissionMaterialHandle {
  anisotropy: number;
  attenuationColor?: THREE.Color;
  chromaticAberration: number;
  color?: THREE.Color;
  distortion: number;
  distortionScale: number;
  envMapIntensity: number;
  iridescence: number;
  iridescenceIOR: number;
  roughness: number;
  thickness: number;
}

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>;

const CUBE_UNIFORM_SIZE = 5;
const IDLE_THRESHOLD_MS = 30_000;
const SLEEP_THRESHOLD_MS = 300_000;
const CUBE_POINTER_CLICK_PX = 10;
const CUBE_POINTER_CLICK_MS = 500;
const CLICK_VISUAL_DURATION = 1.1;
const VISUAL_READY_FRAME_DELAY = 2;
const TILE_VISUAL_READY_FRAME_DELAY = 3;

/** Persists across Home navigations so tile cubes skip the first-load fade on return. */
let projectArtifactTileHasRevealed = false;

const MATERIAL_ANIM = {
  roughness: { min: 0.02, max: 0.075, speed: 2.2 },
  thickness: { min: 0.3, max: 0.6, speed: 0.4 },
  chromaticAberration: { min: 0, max: 0.03, speed: 1 },
  distortion: { min: 0, max: 0, speed: 1 },
  distortionScale: { min: 0.05, max: 0.4, speed: 1 },
  anisotropy: { min: 0, max: 0.3, speed: 1 },
  iridescence: { min: 0, max: 0, speed: 1 },
  iridescenceIOR: { min: 1, max: 1, speed: 1 },
};

const SCENE_ANIM = {
  baseTiltAmplitude: 1,
  baseTiltSpeed: 1,
  breathingAmplitude: 0.4,
  breathingSpeed: 0.3,
  clickPulseStrength: 1,
  contentMicroDriftSpeed: 3,
  contentMicroDriftX: 2.05,
  contentMicroDriftY: 5,
  contentMicroDriftZ: 3,
  dragMomentumLag: 2,
  floatingBobAmplitude: 1,
  floatingBobSpeed: 1,
  gentleDriftAmplitude: 0.7,
  gentleDriftSpeed: 1,
  idleFrostAmount: 1,
  imageCycleDuration: 10,
  innerCubeRotationSpeed: 0.6,
  scrollParallax: 1,
  uvDriftSpeed: 1,
};

const EFFECTS = {
  bloomBoost: 0.5,
  dofBokehScalePreview: 34,
  dofBokehScaleTile: 18,
  dofFocalLength: 0.25,
  envIntensity: 0.5,
  envMapIntensity: 1,
  iridescenceBoost: 0.1,
  lensDistortion: -0.05,
  roughnessBoost: -0.05,
  saturate: 0.9,
  vignetteAmountPreview: 0.06,
  vignetteAmountTile: 0.1,
};

const CANVAS_CAMERA = {
  preview: {
    position: [10.8, 12.6, 10.8] as const,
    fov: 35,
  },
  // Slightly closer than preview so the cube reads large in widgets, with headroom so
  // glass/refraction and idle motion are not clipped by the canvas bounds.
  tile: {
    position: [7.1, 8.25, 7.1] as const,
    fov: 36,
  },
} as const;

function getCanvasCamera(
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>,
  distanceScale = 1,
) {
  const config =
    variant === "tile" ? CANVAS_CAMERA.tile : CANVAS_CAMERA.preview;
  return {
    position: [
      config.position[0] * distanceScale,
      config.position[1] * distanceScale,
      config.position[2] * distanceScale,
    ] as [number, number, number],
    fov: config.fov,
    near: 1,
    far: 100,
  };
}

const NUM_PLANES = 6;
const PLANE_SIZE = 4.2;
const STACK_DEPTH = 3.5;
const PLANE_OPACITY = 0.9;
const PLANE_FADE_DURATION = 3;
const PLANE_CASCADE_OFFSET = 0.15;
const PLANE_CORNER_RADIUS = 0.073;
const INNER_CUBE_SIZE = 7.8;
const SPHERE_RADIUS = 4.5;
const CONTENT_FADE_DURATION = 1.5;

const tempVecA = new THREE.Vector3();
const tempVecB = new THREE.Vector3();
const tempVecC = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();

const roundedPlaneVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const roundedPlaneFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform float uRadius;
  varying vec2 vUv;

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + r;
    return length(max(d, 0.0)) - r;
  }

  void main() {
    vec2 p = vUv - 0.5;
    float d = roundedBoxSDF(p, vec2(0.5), uRadius);
    if (d > 0.0) discard;

    vec4 texColor = texture2D(uMap, vUv);
    gl_FragColor = vec4(texColor.rgb, texColor.a * uOpacity);
  }
`;

const backdropVertexShader = /* glsl */ `
  varying vec3 vLocalPos;
  varying vec3 vLocalNormal;
  void main() {
    vLocalPos = position;
    vLocalNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backdropFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uMapNext;
  uniform float uMix;
  uniform float uOpacity;
  uniform vec3 uBoxSize;
  varying vec3 vLocalPos;
  varying vec3 vLocalNormal;

  vec3 blurSample(sampler2D tex, vec2 uv, float radius) {
    vec3 col = vec3(0.0);
    float total = 0.0;
    for (float x = -1.0; x <= 1.0; x += 1.0) {
      for (float y = -1.0; y <= 1.0; y += 1.0) {
        float w = 1.0 - 0.3 * (abs(x) + abs(y));
        col += texture2D(tex, uv + vec2(x, y) * radius).rgb * w;
        total += w;
      }
    }
    return col / total;
  }

  void main() {
    vec3 blend = abs(vLocalNormal);
    blend = pow(blend, vec3(2.0));
    blend /= (blend.x + blend.y + blend.z);

    vec2 uvXY = vLocalPos.xy / (uBoxSize.xy * 0.86) + 0.5;
    vec2 uvXZ = vLocalPos.xz / (uBoxSize.xz * 0.86) + 0.5;
    vec2 uvYZ = vLocalPos.yz / (uBoxSize.yz * 0.86) + 0.5;

    float blurRadius = 0.7;
    vec3 colA_XY = blurSample(uMap, uvXY, blurRadius);
    vec3 colA_XZ = blurSample(uMap, uvXZ, blurRadius);
    vec3 colA_YZ = blurSample(uMap, uvYZ, blurRadius);
    vec3 colorA = colA_XY * blend.z + colA_XZ * blend.y + colA_YZ * blend.x;

    vec3 colB_XY = blurSample(uMapNext, uvXY, blurRadius);
    vec3 colB_XZ = blurSample(uMapNext, uvXZ, blurRadius);
    vec3 colB_YZ = blurSample(uMapNext, uvYZ, blurRadius);
    vec3 colorB = colB_XY * blend.z + colB_XZ * blend.y + colB_YZ * blend.x;

    vec3 color = mix(colorA, colorB, uMix);
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(lum), color, 1.35);

    gl_FragColor = vec4(color, uOpacity);
  }
`;

const flatProjectionVertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const flatProjectionFragmentShader = /* glsl */ `
  uniform sampler2D uTexture;
  uniform sampler2D uTexture2;
  uniform float uMix;
  uniform float uOpacity;
  uniform vec3 uBoundsMin;
  uniform vec3 uBoundsSize;
  varying vec3 vWorldPos;

  void main() {
    vec2 uv = (vWorldPos.xy - uBoundsMin.xy) / uBoundsSize.xy;
    vec4 texA = texture2D(uTexture, uv);
    vec4 texB = texture2D(uTexture2, uv);
    vec4 color = mix(texA, texB, uMix);
    gl_FragColor = vec4(color.rgb, color.a * uOpacity);
  }
`;

interface ImageCycle {
  currentIndex: number;
  fadeProgress: number;
  isFading: boolean;
  lastCycleTime: number;
  nextCycleVariance: number;
  nextIndex: number;
  transitionEndTime: number;
}

function makeRuntime(initialImageIndex: number): ArtifactRuntimeState {
  return {
    clickPulse: 0,
    contentTransition: 1,
    cursorPosition: { x: 0, y: 0 },
    dragVelocity: 0,
    imageIndex: initialImageIndex,
    isDragging: false,
    isHovered: false,
    isIdle: false,
    isPointerDown: false,
    isTransitioning: false,
    lastInteractionTime: Date.now(),
  };
}

function makeImageCycle(
  initialIndex: number,
  textureCount: number,
): ImageCycle {
  const normalizedIndex = wrapIndex(initialIndex, textureCount);
  return {
    currentIndex: normalizedIndex,
    fadeProgress: 0,
    isFading: false,
    lastCycleTime: 0,
    nextCycleVariance: (Math.random() - 0.5) * 10,
    nextIndex: wrapIndex(normalizedIndex + 1, textureCount),
    transitionEndTime: 0,
  };
}

function wrapIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function initialImageIndexForState(
  state: ProjectArtifactState,
  imageCount: number,
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>,
) {
  if (variant === "tile") return 0;
  return wrapIndex(state.seed, imageCount);
}

function triggerNextImage(cycle: ImageCycle, textureCount: number) {
  if (cycle.isFading) return;
  cycle.nextIndex = wrapIndex(cycle.currentIndex + 1, textureCount);
  cycle.fadeProgress = 0;
  cycle.isFading = true;
}

function advanceImageCycle({
  cycle,
  delta,
  fadeDuration,
  runtime,
  textureCount,
  time,
  totalDuration = fadeDuration,
}: {
  cycle: ImageCycle;
  delta: number;
  fadeDuration: number;
  runtime: ArtifactRuntimeState;
  textureCount: number;
  time: number;
  totalDuration?: number;
}) {
  if (textureCount <= 0) return;
  if (runtime.isTransitioning) cycle.transitionEndTime = time;
  const blocked =
    runtime.isTransitioning || time - cycle.transitionEndTime < 2.0;

  const cycleDuration = SCENE_ANIM.imageCycleDuration + cycle.nextCycleVariance;
  if (
    !blocked &&
    !cycle.isFading &&
    time - cycle.lastCycleTime > cycleDuration
  ) {
    cycle.lastCycleTime = time;
    cycle.nextCycleVariance = (Math.random() - 0.5) * 10;
    triggerNextImage(cycle, textureCount);
  }

  if (cycle.isFading) {
    cycle.fadeProgress += delta / totalDuration;
    if (cycle.fadeProgress >= 1) {
      cycle.fadeProgress = 0;
      cycle.isFading = false;
      cycle.currentIndex = cycle.nextIndex;
      runtime.imageIndex = cycle.currentIndex;
      cycle.nextIndex = wrapIndex(cycle.currentIndex + 1, textureCount);
    }
  }
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

function clamp01(value: number) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function clickEnvelope(elapsed: number, duration: number) {
  if (elapsed < 0 || elapsed > duration) return 0;
  const t = clamp01(elapsed / duration);
  const eased = Math.sin(t * Math.PI);
  return eased * eased;
}

function recordInteraction(runtimeRef: ArtifactRuntimeRef) {
  runtimeRef.current.lastInteractionTime = Date.now();
  runtimeRef.current.isIdle = false;
}

function wave01(time: number, f1: number, f2: number, offset = 0) {
  return (
    (Math.sin(time * f1 + offset) * 0.6 +
      Math.sin(time * f2 + offset * 1.3) * 0.4) *
      0.5 +
    0.5
  );
}

function animatedMaterialValue(
  prop: { min: number; max: number; speed: number },
  time: number,
  f1: number,
  f2: number,
  offset = 0,
) {
  if (prop.speed === 0) return prop.min;
  const t = wave01(time, f1 * prop.speed, f2 * prop.speed, offset);
  return prop.min + (prop.max - prop.min) * t;
}

function textureAt(textures: TextureList, index: number) {
  return textures[wrapIndex(index, textures.length)];
}

function useMemoryTextures(imageUrls: string[]) {
  const textures = useTexture(imageUrls);
  const textureArray = useMemo(
    () => (Array.isArray(textures) ? textures : [textures]),
    [textures],
  );

  useEffect(() => {
    textureArray.forEach((texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
    });
  }, [textureArray]);

  return textureArray;
}

function useMorphedAccentColor(accentColor: string) {
  const colorRef = useRef(new THREE.Color(accentColor));
  const targetRef = useRef(new THREE.Color(accentColor));

  useEffect(() => {
    targetRef.current.set(accentColor);
  }, [accentColor]);

  useFrame((_, delta) => {
    colorRef.current.lerp(targetRef.current, 1 - Math.exp(-delta * 5.4));
  });

  return colorRef;
}

function useGlassTint(accentColorRef: MutableRefObject<THREE.Color>) {
  const tintRef = useRef(new THREE.Color("#ffffff"));

  useFrame(() => {
    tintRef.current.set("#ffffff").lerp(accentColorRef.current, 0.5);
  });

  return tintRef;
}

function useStrictModeSafeDisposal<T>(
  resource: T,
  dispose: (resource: T) => void,
) {
  const pendingDisposalRef = useRef<{
    resource: T;
    timeoutId: number;
  } | null>(null);

  useEffect(() => {
    const pendingDisposal = pendingDisposalRef.current;
    if (pendingDisposal?.resource === resource) {
      window.clearTimeout(pendingDisposal.timeoutId);
      pendingDisposalRef.current = null;
    }

    return () => {
      const timeoutId = window.setTimeout(() => {
        if (pendingDisposalRef.current?.resource === resource) {
          pendingDisposalRef.current = null;
        }
        dispose(resource);
      }, 0);
      pendingDisposalRef.current = { resource, timeoutId };
    };
  }, [dispose, resource]);
}

function disposeThreeResource(resource: { dispose: () => void }) {
  resource.dispose();
}

function getSceneBackgroundColor(
  accentColor: string,
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>,
) {
  const background = new THREE.Color("#f5f5f5");
  if (variant === "preview") {
    background.lerp(new THREE.Color(accentColor), 0.14);
  }
  return `#${background.getHexString()}`;
}

const TRANSPARENT_BACKGROUND_VARIANTS: readonly NonNullable<
  ProjectArtifactRendererProps["variant"]
>[] = ["preview", "tile"];

function usesTransparentBackground(
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>,
) {
  return TRANSPARENT_BACKGROUND_VARIANTS.includes(variant);
}

function SceneBackground({
  color,
  transparent,
}: {
  color: string;
  transparent: boolean;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const clearColor = transparent ? "#000000" : color;
    scene.background = transparent ? null : new THREE.Color(color);
    gl.domElement.style.background = transparent ? "transparent" : color;
    gl.setClearColor(clearColor, transparent ? 0 : 1);
    gl.setClearAlpha(transparent ? 0 : 1);

    return () => {
      if (transparent) scene.background = null;
    };
  }, [color, gl, scene, transparent]);

  return null;
}

function SceneEnvironment({ environmentUrl }: { environmentUrl: string }) {
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const scene = useThree((state) => state.scene);

  useFrame(() => {
    scene.environmentIntensity = EFFECTS.envIntensity;
    if (ambientRef.current) {
      ambientRef.current.intensity +=
        (0.4 - ambientRef.current.intensity) * 0.03;
      ambientRef.current.color.lerp(new THREE.Color("#f5f0eb"), 0.03);
    }
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={0.4} color="#f5f0eb" />
      <Environment files={environmentUrl} background={false} />
    </>
  );
}

function TransparentSceneRender() {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
  }, 1);

  return null;
}

/** Keeps tile/preview canvases rendering after container resizes (home widget scaling). */
function CanvasRenderSync({
  layoutEpoch = 0,
  onContextRestored,
  onNeedsRecovery,
}: {
  layoutEpoch?: number;
  onContextRestored?: () => void;
  onNeedsRecovery?: () => void;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const size = useThree((state) => state.size);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-invalidate when widget layout or canvas size changes
  useEffect(() => {
    invalidate();
  }, [invalidate, layoutEpoch, size.height, size.width]);

  useEffect(() => {
    if (size.width > 0 && size.height > 0) {
      return;
    }

    const parent = gl.domElement.parentElement;
    if (!parent || parent.clientWidth <= 0 || parent.clientHeight <= 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      onNeedsRecovery?.();
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [gl, onNeedsRecovery, size.height, size.width]);

  useEffect(() => {
    const canvas = gl.domElement;
    const handleContextLost = (event: Event) => {
      event.preventDefault();
    };
    const handleContextRestored = () => {
      invalidate();
      onContextRestored?.();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    };
  }, [gl, invalidate, onContextRestored]);

  return null;
}

function StackedPlanesContent({
  runtimeRef,
  textures,
}: {
  runtimeRef: ArtifactRuntimeRef;
  textures: TextureList;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const meshARef = useRef<THREE.Mesh[]>([]);
  const meshBRef = useRef<THREE.Mesh[]>([]);
  const backdropRef = useRef<THREE.Mesh>(null);
  const antiParallelRot = useRef(0);
  const cycleRef = useRef(
    makeImageCycle(runtimeRef.current.imageIndex, textures.length),
  );
  const planePositions = useMemo(() => {
    const positions: number[] = [];
    const halfDepth = STACK_DEPTH / 2;
    for (let i = 0; i < NUM_PLANES; i += 1) {
      positions.push(-halfDepth + (STACK_DEPTH / (NUM_PLANES - 1)) * i);
    }
    return positions;
  }, []);
  const uniforms = useRef({
    A: Array.from({ length: NUM_PLANES }, () => ({
      uMap: { value: null as THREE.Texture | null },
      uOpacity: { value: PLANE_OPACITY },
      uRadius: { value: PLANE_CORNER_RADIUS },
    })),
    B: Array.from({ length: NUM_PLANES }, () => ({
      uMap: { value: null as THREE.Texture | null },
      uOpacity: { value: 0 },
      uRadius: { value: PLANE_CORNER_RADIUS },
    })),
    backdrop: {
      uBoxSize: {
        value: new THREE.Vector3(
          (PLANE_SIZE * 1.56) / 2,
          (PLANE_SIZE * 1.56) / 2,
          STACK_DEPTH * 1.3,
        ),
      },
      uMap: { value: null as THREE.Texture | null },
      uMapNext: { value: null as THREE.Texture | null },
      uMix: { value: 0 },
      uOpacity: { value: 1 },
    },
  });

  useEffect(() => {
    const initialTexture = textureAt(textures, runtimeRef.current.imageIndex);
    uniforms.current.A.forEach((entry) => {
      entry.uMap.value = initialTexture;
    });
    uniforms.current.B.forEach((entry) => {
      entry.uMap.value = initialTexture;
    });
    uniforms.current.backdrop.uMap.value = initialTexture;
    uniforms.current.backdrop.uMapNext.value = initialTexture;
  }, [runtimeRef, textures]);

  useFrame((frameState, delta) => {
    const cycle = cycleRef.current;
    const runtime = runtimeRef.current;
    const time = frameState.clock.elapsedTime;
    advanceImageCycle({
      cycle,
      delta,
      fadeDuration: PLANE_FADE_DURATION,
      runtime,
      textureCount: textures.length,
      time,
      totalDuration:
        PLANE_FADE_DURATION +
        PLANE_CASCADE_OFFSET * (NUM_PLANES - 1) * PLANE_FADE_DURATION,
    });

    const texCurrent = textureAt(textures, cycle.currentIndex);
    const texNext = textureAt(textures, cycle.nextIndex);
    for (let i = 0; i < NUM_PLANES; i += 1) {
      const meshA = meshARef.current[i];
      const meshB = meshBRef.current[i];
      if (!meshA || !meshB) continue;
      const matA = meshA.material as THREE.ShaderMaterial;
      const matB = meshB.material as THREE.ShaderMaterial;
      const planeOffset = i * PLANE_CASCADE_OFFSET;
      const localProgress = cycle.isFading
        ? Math.min(
            1,
            Math.max(
              0,
              (cycle.fadeProgress - planeOffset) /
                (1 - PLANE_CASCADE_OFFSET * (NUM_PLANES - 1)),
            ),
          )
        : 0;
      const eased = smoothstep(localProgress);
      matA.uniforms.uMap.value = texCurrent;
      matB.uniforms.uMap.value = texNext;
      matA.uniforms.uOpacity.value = PLANE_OPACITY * (1 - eased);
      matB.uniforms.uOpacity.value = PLANE_OPACITY * eased;
    }

    if (backdropRef.current) {
      const material = backdropRef.current.material as THREE.ShaderMaterial;
      const midOffset = ((NUM_PLANES - 1) / 2) * PLANE_CASCADE_OFFSET;
      const midProgress = cycle.isFading
        ? Math.min(
            1,
            Math.max(
              0,
              (cycle.fadeProgress - midOffset) /
                (1 - PLANE_CASCADE_OFFSET * (NUM_PLANES - 1)),
            ),
          )
        : 0;
      material.uniforms.uMap.value = texCurrent;
      material.uniforms.uMapNext.value = texNext;
      material.uniforms.uMix.value = smoothstep(midProgress);
    }

    if (groupRef.current) {
      const cameraPosition = frameState.camera.position;
      const worldPos = groupRef.current.getWorldPosition(tempVecA);
      tempVecB.copy(cameraPosition).sub(worldPos).normalize();
      tempVecC
        .set(0, 0, 1)
        .applyQuaternion(groupRef.current.getWorldQuaternion(tempQuat));
      const dotZ = Math.abs(tempVecB.dot(tempVecC));
      const threshold = 0.75;
      const maxRotation = 0.35;
      let targetRotY = 0;
      if (dotZ < threshold) {
        const t = 1 - dotZ / threshold;
        const crossSign =
          Math.sign(tempVecB.x * tempVecC.z - tempVecB.z * tempVecC.x) || 1;
        targetRotY = t * t * maxRotation * crossSign;
      }
      antiParallelRot.current += (targetRotY - antiParallelRot.current) * 0.05;
      groupRef.current.rotation.y = antiParallelRot.current;
      groupRef.current.position.x =
        Math.sin(time * 0.08 * SCENE_ANIM.gentleDriftSpeed) *
        0.15 *
        SCENE_ANIM.gentleDriftAmplitude;
      groupRef.current.position.y =
        Math.cos(time * 0.06 * SCENE_ANIM.gentleDriftSpeed) *
        0.1 *
        SCENE_ANIM.gentleDriftAmplitude;
      const breatheWave =
        Math.sin(time * 1.8 * SCENE_ANIM.breathingSpeed) * 0.6 +
        Math.sin(time * 1.14 * SCENE_ANIM.breathingSpeed) * 0.4;
      const breathe =
        1 -
        0.075 * SCENE_ANIM.breathingAmplitude +
        0.075 * SCENE_ANIM.breathingAmplitude * breatheWave;
      groupRef.current.scale.setScalar(breathe);
    }
  });

  return (
    <group ref={groupRef} renderOrder={-1000}>
      <mesh ref={backdropRef}>
        <boxGeometry
          args={[PLANE_SIZE * 1.56, PLANE_SIZE * 1.56, STACK_DEPTH * 2.6]}
        />
        <shaderMaterial
          depthTest={false}
          fragmentShader={backdropFragmentShader}
          side={THREE.BackSide}
          transparent
          uniforms={uniforms.current.backdrop}
          vertexShader={backdropVertexShader}
        />
      </mesh>
      {planePositions.map((z, index) => (
        <group key={z} position={[0, 0, z]}>
          <mesh
            ref={(element) => {
              if (element) meshARef.current[index] = element;
            }}
          >
            <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
            <shaderMaterial
              depthTest={false}
              fragmentShader={roundedPlaneFragmentShader}
              side={THREE.DoubleSide}
              transparent
              uniforms={uniforms.current.A[index]}
              vertexShader={roundedPlaneVertexShader}
            />
          </mesh>
          <mesh
            position={[0, 0, 0.001]}
            ref={(element) => {
              if (element) meshBRef.current[index] = element;
            }}
          >
            <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
            <shaderMaterial
              depthTest={false}
              fragmentShader={roundedPlaneFragmentShader}
              side={THREE.DoubleSide}
              transparent
              uniforms={uniforms.current.B[index]}
              vertexShader={roundedPlaneVertexShader}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function ImageSphereContent({
  runtimeRef,
  textures,
}: {
  runtimeRef: ArtifactRuntimeRef;
  textures: TextureList;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const cycleRef = useRef(
    makeImageCycle(runtimeRef.current.imageIndex, textures.length),
  );
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        depthTest: false,
        fragmentShader: flatProjectionFragmentShader,
        side: THREE.DoubleSide,
        transparent: true,
        uniforms: {
          uBoundsMin: {
            value: new THREE.Vector3(
              -SPHERE_RADIUS,
              -SPHERE_RADIUS,
              -SPHERE_RADIUS,
            ),
          },
          uBoundsSize: {
            value: new THREE.Vector3(
              SPHERE_RADIUS * 2,
              SPHERE_RADIUS * 2,
              SPHERE_RADIUS * 2,
            ),
          },
          uMix: { value: 0 },
          uOpacity: { value: 0.9 },
          uTexture: { value: null },
          uTexture2: { value: null },
        },
        vertexShader: flatProjectionVertexShader,
      }),
    [],
  );

  useStrictModeSafeDisposal(material, disposeThreeResource);

  useFrame((frameState, delta) => {
    const cycle = cycleRef.current;
    const runtime = runtimeRef.current;
    advanceImageCycle({
      cycle,
      delta,
      fadeDuration: CONTENT_FADE_DURATION,
      runtime,
      textureCount: textures.length,
      time: frameState.clock.elapsedTime,
    });
    material.uniforms.uTexture.value = textureAt(textures, cycle.currentIndex);
    material.uniforms.uTexture2.value = textureAt(textures, cycle.nextIndex);
    material.uniforms.uMix.value = cycle.isFading ? cycle.fadeProgress : 0;

    if (groupRef.current) {
      const time = frameState.clock.elapsedTime;
      const breatheWave =
        Math.sin(time * 1.2 * SCENE_ANIM.breathingSpeed) * 0.6 +
        Math.sin(time * 0.8 * SCENE_ANIM.breathingSpeed) * 0.4;
      const breathe =
        1 -
        0.05 * SCENE_ANIM.breathingAmplitude +
        0.05 * SCENE_ANIM.breathingAmplitude * breatheWave;
      groupRef.current.scale.setScalar(breathe);
    }
  });

  return (
    <group ref={groupRef} renderOrder={-1000}>
      <mesh material={material}>
        <sphereGeometry args={[SPHERE_RADIUS, 64, 64]} />
      </mesh>
    </group>
  );
}

function InnerCubeContent({
  mode,
  runtimeRef,
  textures,
}: {
  mode: "cube" | "cubeStatic";
  runtimeRef: ArtifactRuntimeRef;
  textures: TextureList;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const cubeRef = useRef<THREE.Group>(null);
  const cycleRef = useRef(
    makeImageCycle(runtimeRef.current.imageIndex, textures.length),
  );
  const drifts = useMemo(
    () => [
      { sx: 0.02, sy: 0.01 },
      { sx: -0.02, sy: 0.015 },
      { sx: 0.01, sy: 0.02 },
      { sx: -0.01, sy: -0.02 },
      { sx: 0.015, sy: -0.01 },
      { sx: -0.015, sy: 0.01 },
    ],
    [],
  );
  const materialsA = useMemo(
    () =>
      Array.from(
        { length: 6 },
        () =>
          new THREE.MeshBasicMaterial({
            depthTest: false,
            map: textureAt(textures, runtimeRef.current.imageIndex),
            opacity: 0.9,
            side: THREE.FrontSide,
            transparent: true,
          }),
      ),
    [runtimeRef, textures],
  );
  const materialsB = useMemo(
    () =>
      Array.from(
        { length: 6 },
        () =>
          new THREE.MeshBasicMaterial({
            depthTest: false,
            map: textureAt(textures, runtimeRef.current.imageIndex + 1),
            opacity: 0,
            side: THREE.FrontSide,
            transparent: true,
          }),
      ),
    [runtimeRef, textures],
  );

  const materials = useMemo(
    () => [...materialsA, ...materialsB],
    [materialsA, materialsB],
  );
  useStrictModeSafeDisposal(materials, disposeProjectArtifactCubeMaterials);

  const applyCubeTexture = (
    material: THREE.MeshBasicMaterial,
    texture: THREE.Texture,
    driftFaceIndex: number,
    time: number,
  ) => {
    const map = applyProjectArtifactCubeTexture({
      cloneForUvTransform: mode === "cubeStatic",
      material,
      texture,
    });

    if (mode !== "cubeStatic") {
      return;
    }

    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.offset.x = drifts[driftFaceIndex].sx * time * SCENE_ANIM.uvDriftSpeed;
    map.offset.y = drifts[driftFaceIndex].sy * time * SCENE_ANIM.uvDriftSpeed;
  };

  useFrame((frameState, delta) => {
    const cycle = cycleRef.current;
    const runtime = runtimeRef.current;
    const time = frameState.clock.elapsedTime;
    advanceImageCycle({
      cycle,
      delta,
      fadeDuration: CONTENT_FADE_DURATION,
      runtime,
      textureCount: textures.length,
      time,
    });

    const texA = textureAt(textures, cycle.currentIndex);
    const texB = textureAt(textures, cycle.nextIndex);
    const mix = cycle.isFading ? cycle.fadeProgress : 0;
    materialsA.forEach((material, index) => {
      applyCubeTexture(material, texA, index, time);
      material.opacity = 0.9 * (1 - mix);
    });
    materialsB.forEach((material, index) => {
      applyCubeTexture(material, texB, index, time);
      material.opacity = 0.9 * mix;
    });

    if (cubeRef.current && mode === "cube") {
      cubeRef.current.rotation.x += 0.001 * SCENE_ANIM.innerCubeRotationSpeed;
      cubeRef.current.rotation.y += 0.002 * SCENE_ANIM.innerCubeRotationSpeed;
    }
    if (groupRef.current) {
      const breatheWave =
        Math.sin(time * 1.0 * SCENE_ANIM.breathingSpeed) * 0.6 +
        Math.sin(time * 0.7 * SCENE_ANIM.breathingSpeed) * 0.4;
      const breathe =
        1 -
        0.07 * SCENE_ANIM.breathingAmplitude +
        0.07 * SCENE_ANIM.breathingAmplitude * breatheWave;
      groupRef.current.scale.setScalar(breathe);
    }
  });

  return (
    <group ref={groupRef} renderOrder={-1000}>
      <group ref={cubeRef}>
        <mesh material={materialsA}>
          <boxGeometry
            args={[INNER_CUBE_SIZE, INNER_CUBE_SIZE, INNER_CUBE_SIZE]}
          />
        </mesh>
        <mesh material={materialsB}>
          <boxGeometry
            args={[INNER_CUBE_SIZE, INNER_CUBE_SIZE, INNER_CUBE_SIZE]}
          />
        </mesh>
      </group>
    </group>
  );
}

function MemoryContent({
  mode,
  runtimeRef,
  textures,
}: {
  mode: ProjectArtifactContentMode;
  runtimeRef: ArtifactRuntimeRef;
  textures: TextureList;
}) {
  if (mode === "planes") {
    return <StackedPlanesContent runtimeRef={runtimeRef} textures={textures} />;
  }
  if (mode === "sphere") {
    return <ImageSphereContent runtimeRef={runtimeRef} textures={textures} />;
  }
  return (
    <InnerCubeContent
      mode={mode === "cubeStatic" ? "cubeStatic" : "cube"}
      runtimeRef={runtimeRef}
      textures={textures}
    />
  );
}

function PrototypeCube({
  cameraAnglesRef,
  glassTintRef,
  mode,
  motionImpulse,
  runtimeRef,
  shellRef,
  textures,
  variant,
}: {
  cameraAnglesRef: CameraAnglesRef;
  glassTintRef: MutableRefObject<THREE.Color>;
  mode: ProjectArtifactContentMode;
  motionImpulse: ProjectArtifactRendererProps["motionImpulse"];
  runtimeRef: ArtifactRuntimeRef;
  shellRef: MutableRefObject<THREE.Mesh | null>;
  textures: TextureList;
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const contentRef = useRef<THREE.Group>(null);
  const materialRef = useRef<TransmissionMaterialHandle | null>(null);
  const { nodes } = useGLTF(
    PROJECT_ARTIFACT_CUBE_MODEL_URL,
  ) as unknown as CubeGltf;
  const geometry = nodes.Cube?.geometry ?? null;
  const clickTime = useRef(0);
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const pointerDownTime = useRef(0);
  const hoverLean = useRef({ x: 0, y: 0 });
  const hoverWarmth = useRef(0);
  const proximityEnergy = useRef(0);
  const contentLag = useRef({ x: 0, y: 0, z: 0 });
  const contentDrift = useRef({ x: 0, y: 0, z: 0 });
  const hoverSpin = useRef({ x: 0, y: 0 });
  const hoverSpinVelocity = useRef({ x: 0, y: 0 });
  const previousHoverSpin = useRef({ x: 0, y: 0 });
  const dragVisualAmount = useRef(0);
  const dragVisualPeak = useRef(0);
  const scrollOffset = useRef(0);
  const idleFrost = useRef(0);
  const releaseBounceMat = useRef(0);
  const releaseBounceVel = useRef(0);
  const lastMotionImpulse = useRef(0);
  const wasDragging = useRef(false);
  const previousMode = useRef(mode);
  const interactive = variant === "preview";

  useEffect(() => {
    if (previousMode.current !== mode) {
      runtimeRef.current.contentTransition = 0;
      runtimeRef.current.isTransitioning = true;
      previousMode.current = mode;
    }
  }, [mode, runtimeRef]);

  useEffect(() => {
    if (variant !== "tile" || !motionImpulse) return;
    if (motionImpulse.sequence === lastMotionImpulse.current) return;

    lastMotionImpulse.current = motionImpulse.sequence;
    hoverSpinVelocity.current.x = THREE.MathUtils.clamp(
      hoverSpinVelocity.current.x + motionImpulse.deltaY * 11.5,
      -5,
      5,
    );
    hoverSpinVelocity.current.y = THREE.MathUtils.clamp(
      hoverSpinVelocity.current.y + motionImpulse.deltaX * 11.5,
      -5,
      5,
    );
  }, [motionImpulse, variant]);

  useFrame((frameState, delta) => {
    const runtime = runtimeRef.current;
    const time = frameState.clock.elapsedTime;
    const now = Date.now();
    runtime.isIdle = now - runtime.lastInteractionTime > IDLE_THRESHOLD_MS;
    const isDormant = now - runtime.lastInteractionTime > SLEEP_THRESHOLD_MS;

    if (runtime.isTransitioning) {
      runtime.contentTransition = Math.min(
        1,
        runtime.contentTransition + delta / 1.1,
      );
      if (runtime.contentTransition >= 1) runtime.isTransitioning = false;
    }

    const cursorDist = Math.sqrt(
      runtime.cursorPosition.x * runtime.cursorPosition.x +
        runtime.cursorPosition.y * runtime.cursorPosition.y,
    );
    const targetProximity = runtime.isHovered ? 1 : Math.max(0, 1 - cursorDist);
    proximityEnergy.current +=
      (targetProximity - proximityEnergy.current) * 0.02;

    const attractStrength = interactive ? 0 : 0;
    hoverLean.current.x +=
      (runtime.cursorPosition.x * attractStrength - hoverLean.current.x) * 0.06;
    hoverLean.current.y +=
      (runtime.cursorPosition.y * attractStrength - hoverLean.current.y) * 0.06;
    hoverWarmth.current +=
      ((runtime.isHovered ? 0.6 : 0) - hoverWarmth.current) * 0.03;

    const dragTarget = runtime.isDragging
      ? clamp01((runtime.dragVelocity - 0.00025) / 0.004)
      : 0;
    dragVisualAmount.current +=
      (dragTarget - dragVisualAmount.current) * (dragTarget > 0 ? 0.18 : 0.08);
    const dragAmount = dragVisualAmount.current;
    const longPressAmount = dragAmount;
    const dragActive = dragAmount > 0.03;
    if (dragActive) {
      dragVisualPeak.current = Math.max(dragVisualPeak.current, dragAmount);
    }

    if (wasDragging.current && !dragActive) {
      releaseBounceVel.current = 0.8 * dragVisualPeak.current;
      dragVisualPeak.current = 0;
    }
    wasDragging.current = dragActive;

    const springForce = -25 * releaseBounceMat.current;
    const dampForce = -4 * releaseBounceVel.current;
    releaseBounceVel.current += (springForce + dampForce) * (1 / 60);
    releaseBounceMat.current += releaseBounceVel.current * (1 / 60);
    if (
      Math.abs(releaseBounceMat.current) < 0.001 &&
      Math.abs(releaseBounceVel.current) < 0.001
    ) {
      releaseBounceMat.current = 0;
      releaseBounceVel.current = 0;
    }

    const targetFrost =
      runtime.isIdle || isDormant ? 0.8 * SCENE_ANIM.idleFrostAmount : 0;
    idleFrost.current += (targetFrost - idleFrost.current) * 0.005;
    scrollOffset.current *= 0.95;
    if (variant === "tile") {
      const spinDelta = Math.min(delta, 1 / 30);
      const spring = 8.2;
      const damping = 0.965 ** (spinDelta * 60);
      hoverSpinVelocity.current.x += -hoverSpin.current.x * spring * spinDelta;
      hoverSpinVelocity.current.y += -hoverSpin.current.y * spring * spinDelta;
      hoverSpinVelocity.current.x *= damping;
      hoverSpinVelocity.current.y *= damping;
      hoverSpin.current.x = THREE.MathUtils.clamp(
        hoverSpin.current.x + hoverSpinVelocity.current.x * spinDelta,
        -0.72,
        0.72,
      );
      hoverSpin.current.y = THREE.MathUtils.clamp(
        hoverSpin.current.y + hoverSpinVelocity.current.y * spinDelta,
        -0.72,
        0.72,
      );
      if (Math.abs(hoverSpin.current.x) < 0.0001) hoverSpin.current.x = 0;
      if (Math.abs(hoverSpin.current.y) < 0.0001) hoverSpin.current.y = 0;
      if (Math.abs(hoverSpinVelocity.current.x) < 0.0001) {
        hoverSpinVelocity.current.x = 0;
      }
      if (Math.abs(hoverSpinVelocity.current.y) < 0.0001) {
        hoverSpinVelocity.current.y = 0;
      }
    } else {
      hoverSpin.current.x = 0;
      hoverSpin.current.y = 0;
      hoverSpinVelocity.current.x = 0;
      hoverSpinVelocity.current.y = 0;
      previousHoverSpin.current.x = 0;
      previousHoverSpin.current.y = 0;
    }

    const tileMotionScale = variant === "tile" ? 0.55 : 1;
    const bobY =
      (Math.sin(time * 0.6 * SCENE_ANIM.floatingBobSpeed) * 0.08 +
        Math.sin(time * 0.23 * SCENE_ANIM.floatingBobSpeed) * 0.04) *
      SCENE_ANIM.floatingBobAmplitude *
      tileMotionScale;
    const bobX =
      Math.sin(time * 0.4 * SCENE_ANIM.floatingBobSpeed + 1) *
      0.03 *
      SCENE_ANIM.floatingBobAmplitude *
      tileMotionScale;

    if (shellRef.current) {
      shellRef.current.scale.set(
        CUBE_UNIFORM_SIZE,
        CUBE_UNIFORM_SIZE,
        CUBE_UNIFORM_SIZE,
      );
    }

    if (contentRef.current) {
      const momentumDecay = 0.987;
      const momentumGain = 17.5 * SCENE_ANIM.dragMomentumLag;
      const maxMomentum = 1.75;
      if (Math.abs(runtime.dragVelocity) > 0.001) {
        contentLag.current.x +=
          runtime.dragVelocity * Math.sin(time * 2.3) * momentumGain * 0.016;
        contentLag.current.y +=
          runtime.dragVelocity * Math.cos(time * 1.7) * momentumGain * 0.016;
      }
      contentLag.current.x = THREE.MathUtils.clamp(
        contentLag.current.x,
        -maxMomentum,
        maxMomentum,
      );
      contentLag.current.y = THREE.MathUtils.clamp(
        contentLag.current.y,
        -maxMomentum,
        maxMomentum,
      );
      contentLag.current.x *= momentumDecay;
      contentLag.current.y *= momentumDecay;

      const driftSpeed = SCENE_ANIM.contentMicroDriftSpeed;
      contentDrift.current.x =
        (Math.sin(time * 0.17 * driftSpeed + 1.3) * 0.04 +
          Math.sin(time * 0.31 * driftSpeed) * 0.02) *
        SCENE_ANIM.contentMicroDriftX;
      contentDrift.current.y =
        (Math.sin(time * 0.13 * driftSpeed + 2.7) * 0.03 +
          Math.cos(time * 0.23 * driftSpeed) * 0.02) *
        SCENE_ANIM.contentMicroDriftY;
      contentDrift.current.z =
        (Math.sin(time * 0.11 * driftSpeed + 4.1) * 0.04 +
          Math.cos(time * 0.19 * driftSpeed) * 0.02) *
        SCENE_ANIM.contentMicroDriftZ;
      contentRef.current.rotation.x =
        contentLag.current.x + contentDrift.current.x;
      contentRef.current.rotation.y =
        contentLag.current.y + contentDrift.current.y;
      contentRef.current.rotation.z = contentDrift.current.z;
      contentRef.current.position.z =
        scrollOffset.current * 1.3 * SCENE_ANIM.scrollParallax;
    }

    if (materialRef.current) {
      const material = materialRef.current;
      const energy = 1 + proximityEnergy.current * 0.5;
      const bounce = releaseBounceMat.current;
      const animatedRoughness = Math.max(
        0,
        animatedMaterialValue(MATERIAL_ANIM.roughness, time, 0.16, 0.1) +
          idleFrost.current * 0.15 +
          EFFECTS.roughnessBoost,
      );
      material.roughness = animatedRoughness;
      material.thickness =
        animatedMaterialValue(MATERIAL_ANIM.thickness, time, 0.44, 0.28, 2) +
        bounce * 0.5;
      material.chromaticAberration =
        animatedMaterialValue(
          MATERIAL_ANIM.chromaticAberration,
          time,
          0.6,
          0.38,
          3,
        ) *
          energy +
        hoverWarmth.current * 0.03;
      material.distortion =
        animatedMaterialValue(MATERIAL_ANIM.distortion, time, 0.2, 0.13, 4) *
          energy +
        Math.abs(bounce) * 0.15;
      material.distortionScale = animatedMaterialValue(
        MATERIAL_ANIM.distortionScale,
        time,
        0.09,
        0.055,
        5,
      );
      material.anisotropy = animatedMaterialValue(
        MATERIAL_ANIM.anisotropy,
        time,
        0.07,
        0.045,
        7,
      );
      material.iridescence =
        animatedMaterialValue(MATERIAL_ANIM.iridescence, time, 0.065, 0.04, 8) +
        hoverWarmth.current * 0.1 +
        EFFECTS.iridescenceBoost;
      material.iridescenceIOR = animatedMaterialValue(
        MATERIAL_ANIM.iridescenceIOR,
        time,
        0.04,
        0.025,
        9,
      );
      if (longPressAmount > 0.01) {
        material.thickness += longPressAmount * 0.25;
        material.distortion += longPressAmount * 0.25;
        material.iridescence += longPressAmount * 0.05;
      }
      if (runtime.isTransitioning) {
        const transitionPulse = Math.sin(runtime.contentTransition * Math.PI);
        material.thickness += transitionPulse * 1.5;
        material.roughness += transitionPulse * 0.12;
        material.distortion += transitionPulse * 0.15;
        material.chromaticAberration += transitionPulse * 0.02;
      }
      material.envMapIntensity = EFFECTS.envMapIntensity;
      if (material.attenuationColor instanceof THREE.Color) {
        material.attenuationColor.copy(glassTintRef.current);
      }
      if (material.color instanceof THREE.Color) {
        material.color.copy(glassTintRef.current);
      }
    }

    if (
      clickTime.current > 0 &&
      SCENE_ANIM.clickPulseStrength > 0 &&
      shellRef.current
    ) {
      const elapsed = performance.now() / 1000 - clickTime.current;
      const envelope = clickEnvelope(elapsed, CLICK_VISUAL_DURATION);
      if (envelope > 0) {
        const pulse = envelope * 0.018 * SCENE_ANIM.clickPulseStrength;
        const scale = CUBE_UNIFORM_SIZE * (1 + pulse);
        shellRef.current.scale.set(scale, scale, scale);
        if (materialRef.current) {
          const flash = envelope * SCENE_ANIM.clickPulseStrength;
          materialRef.current.chromaticAberration += flash * 0.12;
          materialRef.current.distortion += flash * 0.08;
        }
      }
    }

    if (groupRef.current) {
      const baseTiltX =
        Math.sin(time * 0.15 * SCENE_ANIM.baseTiltSpeed) *
        0.015 *
        SCENE_ANIM.baseTiltAmplitude;
      const baseTiltZ =
        Math.cos(time * 0.12 * SCENE_ANIM.baseTiltSpeed) *
        0.01 *
        SCENE_ANIM.baseTiltAmplitude;
      const dampFactor = 1 - dragAmount * 0.9;
      groupRef.current.rotation.z +=
        (baseTiltZ * dampFactor - groupRef.current.rotation.z) * 0.03;

      const combinedAngle =
        cameraAnglesRef.current.azimuth + groupRef.current.rotation.y;
      const wrapped =
        (((combinedAngle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) -
        Math.PI / 4;
      const force = -Math.sin(2 * wrapped);
      const momentumFade = Math.max(0, 1 - runtime.dragVelocity / 0.003);
      const antiFlatStrength = dragActive ? 0 : 0.006 * momentumFade;
      const tileSpinX = variant === "tile" ? hoverSpin.current.x : 0;
      const tileSpinY = variant === "tile" ? hoverSpin.current.y : 0;
      const tileSpinDeltaX = tileSpinX - previousHoverSpin.current.x;
      const tileSpinDeltaY = tileSpinY - previousHoverSpin.current.y;
      previousHoverSpin.current.x = tileSpinX;
      previousHoverSpin.current.y = tileSpinY;

      groupRef.current.rotation.y += force * antiFlatStrength + tileSpinDeltaY;
      groupRef.current.rotation.x += tileSpinDeltaX;
      groupRef.current.rotation.x +=
        (baseTiltX * dampFactor - groupRef.current.rotation.x) *
        (variant === "tile" ? 0.045 : 0.03);

      const camera = frameState.camera;
      const matrix = camera.matrixWorld.elements;
      const leanAmount = variant === "tile" ? 1.1 : 2.1;
      const leanX = hoverLean.current.x * leanAmount;
      const leanY = hoverLean.current.y * leanAmount;
      const targetX = bobX + matrix[0] * leanX + matrix[4] * leanY;
      const targetY = 0.25 + bobY + matrix[1] * leanX + matrix[5] * leanY;
      const targetZ = matrix[2] * leanX + matrix[6] * leanY;
      groupRef.current.position.x +=
        (targetX - groupRef.current.position.x) * 0.06;
      groupRef.current.position.y +=
        (targetY - groupRef.current.position.y) * 0.06;
      groupRef.current.position.z +=
        (targetZ - groupRef.current.position.z) * 0.06;
    }
  });

  useFrame(() => {
    if (contentRef.current) contentRef.current.visible = false;
  }, 0.5);

  useFrame(() => {
    if (contentRef.current) contentRef.current.visible = true;
  }, 2);

  const handlePointerDown = (event: CubePointerEvent) => {
    if (!interactive) return;
    event.stopPropagation();
    pointerDownPos.current = { x: event.clientX, y: event.clientY };
    pointerDownTime.current = performance.now();
    runtimeRef.current.isPointerDown = true;
    recordInteraction(runtimeRef);
  };

  const handlePointerUp = (event: CubePointerEvent) => {
    if (!interactive || !pointerDownPos.current) return;
    event.stopPropagation();
    const dx = event.clientX - pointerDownPos.current.x;
    const dy = event.clientY - pointerDownPos.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = performance.now() - pointerDownTime.current;
    pointerDownPos.current = null;
    runtimeRef.current.isPointerDown = false;
    if (dist < CUBE_POINTER_CLICK_PX && elapsed < CUBE_POINTER_CLICK_MS) {
      clickTime.current = performance.now() / 1000;
      runtimeRef.current.clickPulse = Date.now();
      recordInteraction(runtimeRef);
    }
  };

  const handlePointerOver = () => {
    if (!interactive) return;
    runtimeRef.current.isHovered = true;
    recordInteraction(runtimeRef);
  };

  const handlePointerOut = () => {
    if (!interactive) return;
    runtimeRef.current.isHovered = false;
    runtimeRef.current.isPointerDown = false;
    pointerDownPos.current = null;
  };

  return (
    <group ref={groupRef}>
      <mesh
        castShadow
        geometry={geometry ?? undefined}
        name="CubeShell"
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerOut={interactive ? handlePointerOut : undefined}
        onPointerOver={interactive ? handlePointerOver : undefined}
        onPointerUp={interactive ? handlePointerUp : undefined}
        ref={shellRef}
        scale={[CUBE_UNIFORM_SIZE, CUBE_UNIFORM_SIZE, CUBE_UNIFORM_SIZE]}
      >
        {geometry ? null : <boxGeometry args={[1.65, 1.65, 1.65]} />}
        <MeshTransmissionMaterial
          ref={materialRef}
          anisotropy={0}
          attenuationColor={glassTintRef.current}
          attenuationDistance={4.8}
          backside
          backsideEnvMapIntensity={1}
          backsideThickness={0.5}
          chromaticAberration={0.01}
          color={glassTintRef.current}
          distortion={0}
          distortionScale={0}
          iridescence={0}
          iridescenceIOR={1}
          iridescenceThicknessRange={[0, 400]}
          samples={4}
          thickness={0.5}
          transmission={1}
        />
      </mesh>
      <group ref={contentRef}>
        <MemoryContent
          mode={mode}
          runtimeRef={runtimeRef}
          textures={textures}
        />
      </group>
    </group>
  );
}

function CubeInteraction({
  cameraAnglesRef,
  runtimeRef,
}: {
  cameraAnglesRef: CameraAnglesRef;
  runtimeRef: ArtifactRuntimeRef;
}) {
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const prevAzimuth = useRef(0);
  const prevPolar = useRef(0);

  useFrame(() => {
    if (!controlsRef.current) return;
    const controls = controlsRef.current;
    const azimuth = controls.getAzimuthalAngle();
    const polar = controls.getPolarAngle();
    cameraAnglesRef.current.azimuth = azimuth;
    cameraAnglesRef.current.polar = polar;
    const dAzimuth = azimuth - prevAzimuth.current;
    const dPolar = polar - prevPolar.current;
    const angularVelocity = Math.sqrt(dAzimuth * dAzimuth + dPolar * dPolar);
    prevAzimuth.current = azimuth;
    prevPolar.current = polar;

    const runtime = runtimeRef.current;
    if (runtime.isDragging) {
      runtime.dragVelocity = angularVelocity;
    } else if (runtime.dragVelocity > 0.0001) {
      runtime.dragVelocity *= 0.98;
    } else {
      runtime.dragVelocity = 0;
    }
    controls.autoRotate = false;
  });

  return (
    <OrbitControls
      ref={controlsRef}
      dampingFactor={0.04}
      enableDamping
      enablePan={false}
      enableZoom={false}
      maxDistance={30}
      minDistance={15}
      onEnd={() => {
        runtimeRef.current.isDragging = false;
      }}
      onStart={() => {
        runtimeRef.current.isDragging = true;
        recordInteraction(runtimeRef);
      }}
      rotateSpeed={1.2}
    />
  );
}

function ArtifactScene({
  environmentUrl,
  imageUrls,
  motionImpulse,
  runtimeRef,
  state,
  variant,
}: {
  environmentUrl: string;
  imageUrls: string[];
  motionImpulse: ProjectArtifactRendererProps["motionImpulse"];
  runtimeRef: ArtifactRuntimeRef;
  state: ProjectArtifactState;
  variant: NonNullable<ProjectArtifactRendererProps["variant"]>;
}) {
  const textures = useMemoryTextures(imageUrls);
  const shellRef = useRef<THREE.Mesh | null>(null);
  const cameraAnglesRef = useRef<CameraAngles>({ azimuth: 0, polar: 0 });
  const accentColorRef = useMorphedAccentColor(state.accentColor);
  const glassTintRef = useGlassTint(accentColorRef);
  const backgroundColor = useMemo(
    () => getSceneBackgroundColor(state.accentColor, variant),
    [state.accentColor, variant],
  );
  const hasTransparentBackground = usesTransparentBackground(variant);

  return (
    <>
      <SceneBackground
        color={backgroundColor}
        transparent={hasTransparentBackground}
      />
      <SceneEnvironment environmentUrl={environmentUrl} />
      <PrototypeCube
        cameraAnglesRef={cameraAnglesRef}
        glassTintRef={glassTintRef}
        mode={state.contentMode}
        motionImpulse={motionImpulse}
        runtimeRef={runtimeRef}
        shellRef={shellRef}
        textures={textures}
        variant={variant}
      />
      {variant === "preview" ? (
        <CubeInteraction
          cameraAnglesRef={cameraAnglesRef}
          runtimeRef={runtimeRef}
        />
      ) : null}
      {hasTransparentBackground ? <TransparentSceneRender /> : null}
    </>
  );
}

function TileResizeRecovery({
  containerRef,
  onResize,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: () => void;
}) {
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (root.clientWidth > 0 && root.clientHeight > 0) {
          onResize();
        }
      });
    });
    observer.observe(root);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, onResize]);

  return null;
}

export function ProjectArtifactRenderer({
  state,
  environmentUrl,
  imageUrls,
  className,
  cameraDistanceScale = 1,
  gestureFreezeActive = false,
  motionImpulse,
  onGlCanvasReady,
  renderPaused = false,
  variant = "preview",
}: ProjectArtifactRendererProps) {
  const initialImageIndex = initialImageIndexForState(
    state,
    imageUrls.length,
    variant,
  );
  const runtimeRef = useRef<ArtifactRuntimeState>(
    makeRuntime(initialImageIndex),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const interactive = variant === "preview";
  const isRenderWindowVisible = useRenderWindowVisible();
  const pauseRenderLoop = renderPaused || !isRenderWindowVisible;
  const hasTransparentBackground = usesTransparentBackground(variant);
  const canvasBackground = useMemo(
    () => getSceneBackgroundColor(state.accentColor, variant),
    [state.accentColor, variant],
  );
  const [contextRecoveryKey, setContextRecoveryKey] = useState(0);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const lastContextRecoveryAtRef = useRef(0);
  const requestSoftRecovery = useCallback(() => {
    const now = Date.now();
    if (now - lastContextRecoveryAtRef.current < 250) {
      return;
    }
    lastContextRecoveryAtRef.current = now;
    setLayoutEpoch((epoch) => epoch + 1);
  }, []);

  const requestHardRecovery = useCallback(() => {
    const now = Date.now();
    if (now - lastContextRecoveryAtRef.current < 250) {
      return;
    }
    lastContextRecoveryAtRef.current = now;
    setContextRecoveryKey((key) => key + 1);
    setLayoutEpoch((epoch) => epoch + 1);
  }, []);
  const handleTileResize = useCallback(() => {
    setLayoutEpoch((epoch) => epoch + 1);
  }, []);
  const canvasKey = `${variant}-${
    hasTransparentBackground ? "transparent" : "opaque"
  }-${contextRecoveryKey}`;
  const getInitialVisualReady = () =>
    variant === "tile" && projectArtifactTileHasRevealed;
  const [isVisualReady, setIsVisualReady] = useState(getInitialVisualReady);
  const [visualReadyVariant, setVisualReadyVariant] = useState(variant);

  if (visualReadyVariant !== variant) {
    setVisualReadyVariant(variant);
    setIsVisualReady(getInitialVisualReady());
  }

  useEffect(() => {
    const runtime = runtimeRef.current;
    runtime.imageIndex = initialImageIndex;
    runtime.clickPulse = 0;
    runtime.contentTransition = 1;
    runtime.isTransitioning = false;
    runtime.lastInteractionTime = Date.now();
  }, [initialImageIndex]);

  useEffect(() => {
    if (variant !== "tile" || gestureFreezeActive) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      requestSoftRecovery();
    });
    return () => cancelAnimationFrame(frame);
  }, [gestureFreezeActive, requestSoftRecovery, variant]);

  useEffect(() => {
    if (variant === "tile" && projectArtifactTileHasRevealed) {
      return;
    }

    const frameIds: number[] = [];
    let frame = 0;
    const frameDelay =
      variant === "tile"
        ? TILE_VISUAL_READY_FRAME_DELAY
        : VISUAL_READY_FRAME_DELAY;
    const tick = () => {
      frame += 1;
      if (frame >= frameDelay) {
        setIsVisualReady(true);
        if (variant === "tile") {
          projectArtifactTileHasRevealed = true;
        }
        return;
      }
      frameIds.push(requestAnimationFrame(tick));
    };
    frameIds.push(requestAnimationFrame(tick));

    return () => {
      frameIds.forEach(cancelAnimationFrame);
    };
  }, [variant]);

  const handleWebGLContextRestored = useCallback(() => {
    requestHardRecovery();
  }, [requestHardRecovery]);

  const updateCursorPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    runtimeRef.current.cursorPosition = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateCursorPosition(event);
    if (interactive) recordInteraction(runtimeRef);
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateCursorPosition(event);
    runtimeRef.current.isHovered = true;
    recordInteraction(runtimeRef);
  };

  const handlePointerLeave = () => {
    runtimeRef.current.isHovered = false;
    runtimeRef.current.isPointerDown = false;
    runtimeRef.current.isDragging = false;
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative isolate h-full w-full",
        variant === "tile"
          ? "pointer-events-none overflow-visible bg-transparent [transform:translateZ(0)]"
          : "overflow-hidden rounded-[28px] bg-transparent cursor-grab active:cursor-grabbing",
        className,
      )}
      onPointerEnter={interactive ? handlePointerEnter : undefined}
      onPointerLeave={interactive ? handlePointerLeave : undefined}
      onPointerMove={interactive ? handlePointerMove : undefined}
    >
      {variant === "tile" ? (
        <TileResizeRecovery
          containerRef={containerRef}
          onResize={handleTileResize}
        />
      ) : null}
      {variant === "preview" ? (
        <div
          className="pointer-events-none absolute inset-[8%] opacity-30 transition-colors duration-700 ease-out"
          style={{
            background: `radial-gradient(ellipse at center, ${state.accentColor} 0%, ${state.accentColor} 28%, transparent 66%)`,
          }}
        />
      ) : null}
      <div
        className={cn(
          "absolute inset-0 z-10",
          variant === "tile" ? "overflow-visible" : "rounded-[28px]",
          variant === "tile"
            ? projectArtifactTileHasRevealed
              ? "opacity-100"
              : cn(
                  "transition-opacity duration-200",
                  isVisualReady ? "opacity-100" : "opacity-0",
                )
            : cn(
                "ease-out transition-[filter,opacity] duration-300",
                isVisualReady ? "opacity-100 blur-0" : "opacity-0 blur-md",
              ),
        )}
      >
        <Canvas
          key={canvasKey}
          camera={getCanvasCamera(variant, cameraDistanceScale)}
          className={cn(
            "relative h-full w-full [transform:translateZ(0)]",
            variant === "tile" ? "overflow-visible" : "rounded-[28px]",
          )}
          dpr={[1, variant === "tile" ? 1.25 : 1.5]}
          frameloop={
            pauseRenderLoop || (variant === "tile" && gestureFreezeActive)
              ? "demand"
              : "always"
          }
          resize={{ offsetSize: true, debounce: 0 }}
          gl={{
            alpha: hasTransparentBackground,
            antialias: true,
            premultipliedAlpha: true,
            preserveDrawingBuffer: variant === "tile",
            powerPreference: "high-performance",
            stencil: false,
          }}
          style={{
            backgroundColor: hasTransparentBackground
              ? "transparent"
              : canvasBackground,
          }}
          onCreated={({ gl, scene }) => {
            gl.domElement.style.background = hasTransparentBackground
              ? "transparent"
              : canvasBackground;
            gl.setClearAlpha(hasTransparentBackground ? 0 : 1);
            gl.setClearColor(
              hasTransparentBackground ? "#000000" : canvasBackground,
              hasTransparentBackground ? 0 : 1,
            );
            scene.environmentIntensity = EFFECTS.envIntensity;
            onGlCanvasReady?.(gl.domElement);
          }}
        >
          <CanvasRenderSync
            layoutEpoch={layoutEpoch}
            onContextRestored={handleWebGLContextRestored}
            onNeedsRecovery={requestSoftRecovery}
          />
          <Suspense fallback={null}>
            <ArtifactScene
              environmentUrl={environmentUrl}
              imageUrls={imageUrls}
              motionImpulse={motionImpulse}
              runtimeRef={runtimeRef}
              state={state}
              variant={variant}
            />
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}

useGLTF.preload(PROJECT_ARTIFACT_CUBE_MODEL_URL);
