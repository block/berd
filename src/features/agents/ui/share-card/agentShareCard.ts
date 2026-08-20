import cardFoil from "@/features/agents/assets/share-card/card-foil.png";
import berdCardLogo from "@/features/agents/assets/share-card/berd-card-logo.svg";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import type { Persona } from "@/shared/types/agents";
import { getRealPersonaDescription } from "@/features/agents/lib/personaPresentation";
import { deriveAgentCardDescription } from "./agentShareCardDescription";
import {
  fallbackAgentCardColor,
  sampleAgentAvatarColor,
} from "./agentCardColor";
import { AGENT_CARD_HEIGHT, AGENT_CARD_WIDTH } from "./agentShareCardSpec";
import {
  deriveAgentShareCardTextLayout,
  wrapAgentCardText,
} from "./agentShareCardLayout";
import { loadAgentCardFonts } from "./agentShareCardFonts";
import { AGENT_CARD_GEOMETRY } from "./agentShareCardGeometry";

export const AVATAR_VIDEO_LOAD_TIMEOUT_MS = 10_000;
export const SHARE_CARD_IMAGE_LOAD_TIMEOUT_MS = 10_000;

export function getAgentShareCardBase(_personaId: string): string {
  return cardFoil;
}

export function getAgentShareDescription(
  persona: Persona,
  fallback?: string,
): string {
  return (
    getRealPersonaDescription(persona) ??
    deriveAgentCardDescription(
      persona.systemPrompt,
      persona.displayName,
      fallback,
    )
  );
}

export function getAgentShareFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || "agent"}.agent.png`;
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
  // Legacy animated avatars may not have retained their source still. In
  // that case the share card intentionally uses the video's starting frame.
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

export function wrapShareCardText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  return wrapAgentCardText(
    text,
    maxWidth,
    maxLines,
    (value) => context.measureText(value).width,
  );
}

function drawContainedImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
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
  cardBase: string,
  locale: string,
  description = getAgentShareDescription(persona),
): Promise<Blob> {
  const [base, avatar, berdMark] = await Promise.all([
    loadShareCardImage(cardBase),
    loadShareCardImage(avatarSrc),
    loadShareCardImage(berdCardLogo),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = AGENT_CARD_WIDTH;
  canvas.height = AGENT_CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Card rendering is unavailable");

  context.drawImage(base, 0, 0, AGENT_CARD_WIDTH, AGENT_CARD_HEIGHT);
  const accentColor =
    sampleAgentAvatarColor(avatar) ?? fallbackAgentCardColor(persona.id);
  context.save();
  context.globalCompositeOperation = "color";
  context.globalAlpha = 0.34;
  context.fillStyle = accentColor;
  drawAgentCardFrame(context);
  context.fill("evenodd");
  context.restore();
  context.save();
  context.globalAlpha = 0.95;
  context.fillStyle = "white";
  const { panel } = AGENT_CARD_GEOMETRY;
  roundedRect(
    context,
    panel.x,
    panel.y,
    panel.width,
    panel.height,
    panel.radius,
  );
  context.fill();
  context.restore();

  const {
    logo,
    brand,
    avatar: avatarGeometry,
    title: titleGeometry,
    description: descriptionGeometry,
  } = AGENT_CARD_GEOMETRY;
  context.drawImage(berdMark, logo.x, logo.y, logo.width, logo.height);

  await loadAgentCardFonts();
  context.fillStyle = "black";
  context.textBaseline = "alphabetic";
  context.font = "600 36px Inter, sans-serif";
  context.textAlign = "right";
  context.fillText("BERD AGENT", brand.x, brand.y);

  // Berd avatars are character illustrations, not portrait photographs. Keep
  // the full artwork visible instead of applying Buzz's circular cover crop.
  drawContainedImage(
    context,
    avatar,
    avatarGeometry.x,
    avatarGeometry.y,
    avatarGeometry.width,
    avatarGeometry.height,
  );

  context.fillStyle = "black";
  context.textAlign = "left";
  const measureTitle = (value: string) => {
    context.font = "600 64px Inter, sans-serif";
    return context.measureText(value).width;
  };
  const measureDescription = (value: string) => {
    context.font = "600 42px Inter, sans-serif";
    return context.measureText(value).width;
  };
  const { title, descriptionLines, contentShift } =
    deriveAgentShareCardTextLayout(
      persona.displayName,
      description,
      measureTitle,
      measureDescription,
      locale,
    );

  context.font = "600 64px Inter, sans-serif";
  context.fillText(title, titleGeometry.x, titleGeometry.y - contentShift);

  context.font = "600 42px Inter, sans-serif";
  descriptionLines.forEach((line, index) => {
    context.fillText(
      line,
      descriptionGeometry.x,
      descriptionGeometry.y -
        contentShift +
        index * descriptionGeometry.lineHeight,
    );
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Failed to create card image")),
      "image/png",
    );
  });
}

function drawAgentCardFrame(context: CanvasRenderingContext2D): void {
  const { width, height, panel } = AGENT_CARD_GEOMETRY;
  context.beginPath();
  context.rect(0, 0, width, height);
  addRoundedRectPath(
    context,
    panel.x,
    panel.y,
    panel.width,
    panel.height,
    panel.radius,
  );
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  addRoundedRectPath(context, x, y, width, height, radius);
}

function addRoundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
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
