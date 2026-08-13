type ColorAccumulator = {
  blue: number;
  green: number;
  red: number;
  weight: number;
};

type ColorSample = ColorAccumulator & { hue: number };

const HUE_BIN_COUNT = 24;
const HUE_CLUSTER_RADIUS = 2;
const SAMPLE_SIZE = 24;

export function fallbackAgentCardColor(seed: string): string {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return `hsl(${hash % 360} 68% 56%)`;
}

export function sampleAgentAvatarColor(
  image: CanvasImageSource,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return sampleRepresentativeAvatarColor(
      context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data,
    );
  } catch {
    return null;
  }
}

export function sampleRepresentativeAvatarColor(
  pixels: Uint8ClampedArray,
): string | null {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return null;
  const samples: ColorSample[] = [];
  const hueWeights = Array<number>(HUE_BIN_COUNT).fill(0);
  const neutral = emptyAccumulator();

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const alpha = (pixels[offset + 3] ?? 0) / 255;
    if (alpha < 0.25) continue;
    const maximum = Math.max(red, green, blue) / 255;
    const minimum = Math.min(red, green, blue) / 255;
    const lightness = (maximum + minimum) / 2;
    if (lightness < 0.07 || lightness > 0.95) continue;
    const chroma = maximum - minimum;
    const saturation =
      chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
    const weight = alpha * (1 - Math.abs(lightness - 0.5) * 0.9);
    accumulate(neutral, red, green, blue, weight);
    if (saturation < 0.18) continue;
    const hue = rgbHue(red / 255, green / 255, blue / 255, maximum, minimum);
    samples.push({ blue, green, hue, red, weight });
    hueWeights[Math.floor((hue / 360) * HUE_BIN_COUNT) % HUE_BIN_COUNT] +=
      weight;
  }
  if (samples.length === 0) return formatAccumulator(neutral);

  const clusteredWeight = (center: number) => {
    let weight = 0;
    for (
      let delta = -HUE_CLUSTER_RADIUS;
      delta <= HUE_CLUSTER_RADIUS;
      delta++
    ) {
      weight +=
        hueWeights[(center + delta + HUE_BIN_COUNT) % HUE_BIN_COUNT] ?? 0;
    }
    return weight;
  };
  const dominantBin = hueWeights.reduce(
    (best, _, bin) =>
      clusteredWeight(bin) > clusteredWeight(best) ? bin : best,
    0,
  );
  const dominantHue = ((dominantBin + 0.5) / HUE_BIN_COUNT) * 360;
  const maximumDistance = ((HUE_CLUSTER_RADIUS + 0.5) / HUE_BIN_COUNT) * 360;
  const dominant = emptyAccumulator();
  for (const sample of samples) {
    const distance = Math.abs(sample.hue - dominantHue);
    if (Math.min(distance, 360 - distance) <= maximumDistance) {
      accumulate(
        dominant,
        sample.red,
        sample.green,
        sample.blue,
        sample.weight,
      );
    }
  }
  return formatAccumulator(dominant.weight > 0 ? dominant : neutral);
}

function emptyAccumulator(): ColorAccumulator {
  return { blue: 0, green: 0, red: 0, weight: 0 };
}

function accumulate(
  accumulator: ColorAccumulator,
  red: number,
  green: number,
  blue: number,
  weight: number,
) {
  accumulator.red += red * weight;
  accumulator.green += green * weight;
  accumulator.blue += blue * weight;
  accumulator.weight += weight;
}

function rgbHue(
  red: number,
  green: number,
  blue: number,
  maximum: number,
  minimum: number,
): number {
  const chroma = maximum - minimum;
  if (chroma === 0) return 0;
  const hue =
    maximum === red
      ? ((green - blue) / chroma) % 6
      : maximum === green
        ? (blue - red) / chroma + 2
        : (red - green) / chroma + 4;
  return (((hue * 60) % 360) + 360) % 360;
}

function formatAccumulator(value: ColorAccumulator): string | null {
  if (value.weight === 0) return null;
  return `rgb(${Math.round(value.red / value.weight)} ${Math.round(value.green / value.weight)} ${Math.round(value.blue / value.weight)})`;
}
