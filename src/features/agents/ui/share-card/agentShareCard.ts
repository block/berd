import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import type { Persona } from "@/shared/types/agents";
import { agentShareCardBases } from "./shareCardArtworks";

const CARD_WIDTH = 642;
const CARD_HEIGHT = 898;
export const AVATAR_VIDEO_LOAD_TIMEOUT_MS = 10_000;
export const SHARE_CARD_IMAGE_LOAD_TIMEOUT_MS = 10_000;
function stableIndex(value: string, length: number): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % length;
}

export function getAgentShareCardBase(personaId: string): string {
  return agentShareCardBases[
    stableIndex(personaId, agentShareCardBases.length)
  ];
}

export function getAgentShareDescription(persona: Persona): string {
  const sourceDescription = persona.sourceDescription?.trim();
  const candidate =
    sourceDescription && sourceDescription.toLowerCase() !== "agent"
      ? sourceDescription
      : persona.systemPrompt.trim();

  return candidate;
}

export function getAgentShareFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || "agent"}-card.png`;
}

export function loadAvatarVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    const cleanup = () => {
      video.onloadeddata = null;
      video.onerror = null;
      clearTimeout(timeout);
    };
    const finish = (result: { video: HTMLVideoElement } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("video" in result) {
        resolve(result.video);
      } else {
        video.removeAttribute("src");
        video.load();
        reject(result.error);
      }
    };
    const timeout = window.setTimeout(() => {
      finish({ error: new Error("Avatar video loading timed out") });
    }, AVATAR_VIDEO_LOAD_TIMEOUT_MS);

    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.onloadeddata = () => finish({ video });
    video.onerror = () =>
      finish({ error: new Error("Failed to load avatar video") });
    video.src = src;
    video.load();
  });
}

export async function createAvatarPoster(
  media: ResolvedAvatarMedia,
): Promise<string> {
  if (media.posterSrc) return media.posterSrc;
  if (media.mediaType === "image") return media.src;

  const video = await loadAvatarVideo(media.src);
  const sourceWidth = video.videoWidth;
  const sourceHeight =
    media.alphaMode === "stacked"
      ? Math.floor(video.videoHeight / 2)
      : video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error("Avatar video has no drawable frame");
  }

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Avatar poster rendering is unavailable");
  context.drawImage(
    video,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  if (media.alphaMode === "stacked") {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = sourceWidth;
    maskCanvas.height = sourceHeight;
    const maskContext = maskCanvas.getContext("2d");
    if (!maskContext) throw new Error("Avatar mask rendering is unavailable");
    maskContext.drawImage(
      video,
      0,
      sourceHeight,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );
    const color = context.getImageData(0, 0, sourceWidth, sourceHeight);
    const mask = maskContext.getImageData(0, 0, sourceWidth, sourceHeight);
    for (let index = 0; index < color.data.length; index += 4) {
      color.data[index + 3] = mask.data[index];
    }
    context.putImageData(color, 0, 0);
  }

  video.removeAttribute("src");
  video.load();
  return canvas.toDataURL("image/png");
}

export function loadShareCardImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      clearTimeout(timeout);
    };
    const finish = (result: { image: HTMLImageElement } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("image" in result) {
        resolve(result.image);
      } else {
        image.removeAttribute("src");
        reject(result.error);
      }
    };
    const timeout = window.setTimeout(() => {
      finish({ error: new Error("Share card image loading timed out") });
    }, SHARE_CARD_IMAGE_LOAD_TIMEOUT_MS);

    image.crossOrigin = "anonymous";
    image.onload = () => finish({ image });
    image.onerror = () =>
      finish({ error: new Error("Failed to load card artwork") });
    image.src = src;
  });
}

function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  addEllipsis = false,
): string {
  const suffix = addEllipsis ? "…" : "";
  if (context.measureText(`${text}${suffix}`).width <= maxWidth) {
    return `${text}${suffix}`;
  }

  let fitted = text;
  while (fitted && context.measureText(`${fitted}${suffix}`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted}${suffix}`;
}

export function wrapShareCardText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const fittedWord =
      context.measureText(word).width > maxWidth
        ? fitText(context, word, maxWidth, true)
        : word;
    const candidate = line ? `${line} ${fittedWord}` : fittedWord;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    lines.push(line);
    if (lines.length === maxLines) {
      lines[maxLines - 1] = fitText(
        context,
        lines[maxLines - 1],
        maxWidth,
        true,
      );
      return lines;
    }
    line = fittedWord;
  }

  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const clamped = lines.slice(0, maxLines);
    clamped[maxLines - 1] = fitText(
      context,
      clamped[maxLines - 1],
      maxWidth,
      true,
    );
    return clamped;
  }
  return lines;
}

function drawCenteredLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  centerX: number,
  centerY: number,
  lineHeight: number,
): void {
  const firstLineY = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    context.fillText(line, centerX, firstLineY + index * lineHeight);
  });
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    x + (width - drawnWidth) / 2,
    y + (height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
}

export async function renderAgentShareCard(
  persona: Persona,
  avatarSrc: string,
  cardBase = getAgentShareCardBase(persona.id),
): Promise<Blob> {
  const [base, avatar] = await Promise.all([
    loadShareCardImage(cardBase),
    loadShareCardImage(avatarSrc),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Card rendering is unavailable");

  context.drawImage(base, 0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.fillStyle = "#43005c";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "700 60px Inter, sans-serif";
  const headerLines = wrapShareCardText(context, persona.displayName, 510, 2);
  const headerLineHeight = 62;
  const headerCenterY = 105;
  drawCenteredLines(
    context,
    headerLines,
    CARD_WIDTH / 2,
    headerCenterY,
    headerLineHeight,
  );

  // The preview uses 12 CSS pixels at roughly half the native card width.
  context.font = "400 24px Inter, sans-serif";
  const descriptionLines = wrapShareCardText(
    context,
    getAgentShareDescription(persona),
    500,
    4,
  );
  const descriptionLineHeight = 31;
  const descriptionBottom = 826;
  const descriptionHeight = Math.max(
    descriptionLineHeight,
    descriptionLines.length * descriptionLineHeight,
  );
  const descriptionCenterY = descriptionBottom - descriptionHeight / 2;
  drawCenteredLines(
    context,
    descriptionLines,
    CARD_WIDTH / 2,
    descriptionCenterY,
    descriptionLineHeight,
  );

  const headerBottom =
    headerCenterY + (headerLines.length * headerLineHeight) / 2 + 28;
  const descriptionTop = descriptionBottom - descriptionHeight - 28;
  drawContainedImage(
    context,
    avatar,
    112,
    headerBottom,
    418,
    Math.max(1, descriptionTop - headerBottom),
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Failed to create card image")),
      "image/png",
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
