// ============================================
// Memory Cube — Screen-Space Distortion Effect
// ============================================
// A custom postprocessing Effect that warps pixels in the
// area around the cube using animated noise. Creates organic,
// dreamy distortion without touching geometry.
//
// Features:
//   - Localized to cube area (radial falloff from screen center)
//   - Multi-octave noise displacement of UV coordinates
//   - Click ripple (concentric wave from center)
//   - Idle melt (downward UV drift)
//   - Drag turbulence (high-frequency noise burst)
//   - Chromatic split on distorted areas
//
// REVERT: Remove from PostProcessing.tsx effect pass,
//         delete this file.

import { Effect } from "postprocessing";
import { Uniform, Vector2 } from "three";
import type { WebGLRenderer, WebGLRenderTarget } from "three";

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uNoiseAmp;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uRippleStrength;
  uniform float uRippleTime;
  uniform float uMeltAmount;
  uniform float uTurbulence;
  uniform float uRadius;
  uniform vec2 uCenter;
  uniform vec2 uRippleCenter;

  // Simplex-ish noise (2D for screen space)
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void mainUv(inout vec2 uv) {
    // Distance from cube center (screen space)
    vec2 delta = uv - uCenter;
    float dist = length(delta);

    // Flat mask with soft edge — uniform strength inside, fades only at border
    float mask = smoothstep(uRadius, uRadius * 0.75, dist);
    if (mask < 0.001) return; // early out for pixels far from cube

    float t = uTime * uNoiseSpeed;
    vec2 offset = vec2(0.0);

    // 1. ORGANIC NOISE — multi-octave UV displacement (curl-noise style for no pinching)
    float n1x = snoise(uv * uNoiseScale + vec2(0.0, t * 0.4));
    float n1y = snoise(uv * uNoiseScale + vec2(t * 0.4, 0.0) + 3.7);
    float n2x = snoise(uv * uNoiseScale * 2.3 + vec2(0.0, t * 0.6) + 7.1);
    float n2y = snoise(uv * uNoiseScale * 2.3 + vec2(t * 0.6, 0.0) + 11.3);
    offset.x += (n1x + n2x * 0.4) * uNoiseAmp;
    offset.y += (n1y + n2y * 0.4) * uNoiseAmp;

    // 2. CLICK RIPPLE — slow, thick wave that rolls outward like water
    if (uRippleStrength > 0.001) {
      float timeSince = uTime - uRippleTime;
      vec2 rippleDelta = uv - uRippleCenter;
      float rippleDist = length(rippleDelta);

      // Wave front expansion speed
      float waveRadius = timeSince * 0.6;

      // Thick, soft ring — gaussian envelope around the wave front
      float ringWidth = 0.08 + timeSince * 0.03; // widens as it travels
      float ringFalloff = exp(-pow(rippleDist - waveRadius, 2.0) / (2.0 * ringWidth * ringWidth));

      // Multiple ripples within the ring
      float wave = sin((rippleDist - waveRadius) * 18.0 - timeSince * 2.0) * ringFalloff;

      // Fade over time
      float envelope = exp(-timeSince * 2.5);

      vec2 rippleDir = normalize(rippleDelta + 0.0001);
      offset += rippleDir * wave * envelope * uRippleStrength * 0.04;
    }

    // 3. IDLE MELT — downward UV drift
    if (uMeltAmount > 0.001) {
      float meltNoise = snoise(uv * 3.0 + t * 0.2) * 0.5 + 0.5;
      offset.y += uMeltAmount * 0.03 * meltNoise;
    }

    // 4. TURBULENCE — smooth, large-scale warping during drag
    if (uTurbulence > 0.001) {
      float tn1 = snoise(uv * 4.0 + uTime * 0.8);
      float tn2 = snoise(uv * 4.0 + uTime * 0.8 + 50.0);
      offset += vec2(tn1, tn2) * uTurbulence * 0.02;
    }

    // Apply with mask
    uv += offset * mask;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = inputColor;
  }
`;

export class CubeDistortionEffect extends Effect {
  constructor() {
    super("CubeDistortionEffect", fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ["uTime", new Uniform(0)],
        ["uNoiseAmp", new Uniform(0.008)],
        ["uNoiseScale", new Uniform(1.0)],
        ["uNoiseSpeed", new Uniform(0.4)],
        ["uRippleStrength", new Uniform(0.0)],
        ["uRippleTime", new Uniform(0.0)],
        ["uMeltAmount", new Uniform(0.0)],
        ["uTurbulence", new Uniform(0.0)],
        ["uRadius", new Uniform(0.4)],
        ["uCenter", new Uniform(new Vector2(0.5, 0.55))], // slightly above center (cube floats up)
        ["uRippleCenter", new Uniform(new Vector2(0.5, 0.5))],
      ]),
    });
  }

  update(
    _renderer: WebGLRenderer,
    _inputBuffer: WebGLRenderTarget,
    deltaTime: number,
  ) {
    const time = this.uniforms.get("uTime");
    if (time) time.value += deltaTime;
  }
}
