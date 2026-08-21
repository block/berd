import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Persona } from "@/shared/types/agents";
import {
  isSafePngAvatarDataUrl,
  MAX_PNG_AVATAR_BYTES,
} from "@/shared/lib/avatarUrl";
import {
  AgentSnapshotError,
  encodeAgentImage,
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES,
  personaToSnapshot,
} from "@/features/agents/agent-snapshot";
import {
  useAvatarImage,
  useAvatarMediaState,
} from "@/shared/hooks/useAvatarSrc";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { readCachedAvatarAnimation } from "@/shared/api/avatars";
import { SplitButton } from "@/shared/ui/split-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { AgentShareCardPreview } from "./AgentShareCardPreview";
import { AgentCardReveal } from "./AgentCardReveal";
import {
  blobToBytes,
  createAvatarPoster,
  downloadBlob,
  getAgentShareCardBase,
  getAgentShareDescription,
  getAgentShareFilename,
  renderAgentShareCard,
} from "./agentShareCard";

async function avatarSourceToDataUrl(source: string): Promise<string | null> {
  if (isSafePngAvatarDataUrl(source)) return source;
  try {
    const response = await fetch(source);
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PNG_AVATAR_BYTES
    ) {
      return null;
    }
    const blob = await response.blob();
    if (
      blob.size > MAX_PNG_AVATAR_BYTES ||
      (blob.type && blob.type !== "image/png")
    ) {
      return null;
    }
    const bytes = await blobToBytes(blob);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const dataUrl = `data:image/png;base64,${btoa(binary)}`;
    return isSafePngAvatarDataUrl(dataUrl) ? dataUrl : null;
  } catch {
    return null;
  }
}

export const AVATAR_ANIMATION_EMBED_TIMEOUT_MS = 5_000;
export const AGENT_ZIP_TIMEOUT_MS = 15_000;

export function createAgentZip(
  pngFilename: string,
  contents: Uint8Array,
  signal?: AbortSignal,
  timeoutMs = AGENT_ZIP_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./agentZip.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error("ZIP worker timed out")));
    }, timeoutMs);
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
      operation();
    };
    const handleAbort = () =>
      finish(() => reject(new DOMException("Aborted", "AbortError")));
    worker.onmessage = (
      event: MessageEvent<{ archive?: Uint8Array; error?: string }>,
    ) => {
      const { archive, error } = event.data;
      if (error) finish(() => reject(new Error(error)));
      else if (archive) finish(() => resolve(archive));
      else finish(() => reject(new Error("ZIP worker returned no archive")));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "ZIP worker failed")));
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
    // Copy before transfer so the portable PNG remains available to the caller.
    const workerContents = new Uint8Array(contents);
    worker.postMessage({ pngFilename, contents: workerContents }, [
      workerContents.buffer,
    ]);
  });
}

async function withAnimationEmbedDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = AVATAR_ANIMATION_EMBED_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeout: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => {
      controller.abort();
      reject(new Error("Avatar animation request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

interface AgentShareDialogProps {
  open: boolean;
  persona: Persona;
  onOpenChange: (open: boolean) => void;
  onDownloadAgent: (persona: Persona) => void | Promise<void>;
}

export function AgentShareDialog({
  open,
  persona,
  onOpenChange,
  onDownloadAgent,
}: AgentShareDialogProps) {
  const { t, i18n } = useTranslation("agents");
  const shouldReduceMotion = useReducedMotion();
  const [avatarReadySrc, setAvatarReadySrc] = useState<string | null>(null);
  const [failedAvatarSources, setFailedAvatarSources] = useState<Set<string>>(
    () => new Set(),
  );
  const [cardDownloadPending, setCardDownloadPending] = useState(false);
  const [agentDownloadPending, setAgentDownloadPending] = useState(false);
  const [generatedAvatarPoster, setGeneratedAvatarPoster] = useState<{
    avatar: Persona["avatar"];
    src: string;
  } | null>(null);
  const avatarPreloadRef = useRef<HTMLImageElement>(null);
  const cardDownloadInFlightRef = useRef<number | null>(null);
  const agentDownloadInFlightRef = useRef(false);
  const cardOperationGenerationRef = useRef(0);
  const cardOperationAbortRef = useRef<AbortController | null>(null);
  const resolvedAvatar = useAvatarImage(persona.avatar);
  const cachedAvatarState = useAvatarMediaState(persona.avatar);
  const cachedAvatar = cachedAvatarState.media;
  const fallbackAvatarSrc = resolveAgentIcon(persona.id);
  const currentGeneratedAvatarPoster =
    generatedAvatarPoster && generatedAvatarPoster.avatar === persona.avatar
      ? generatedAvatarPoster.src
      : undefined;
  const cachedAvatarImage =
    cachedAvatar?.posterSrc ??
    (cachedAvatar?.mediaType === "image" ? cachedAvatar.src : undefined);
  const avatarCandidates = [
    resolvedAvatar,
    currentGeneratedAvatarPoster,
    cachedAvatarImage,
    // Keep a local last-resort source even for configured avatars. Broken,
    // offline, and legacy refs must not strand Share in a permanent loader.
    fallbackAvatarSrc,
  ].filter((source): source is string => Boolean(source));
  const avatarSrc = avatarCandidates.find(
    (source) => !failedAvatarSources.has(source),
  );
  const avatarUnavailable = avatarCandidates.every((source) =>
    failedAvatarSources.has(source),
  );
  // The card can render as soon as the exact still image it will display has
  // decoded. Cached animation/poster resolution may continue independently.
  const cardReady = Boolean(avatarSrc && avatarReadySrc === avatarSrc);
  const cardBase = getAgentShareCardBase(persona.id);
  const locale = i18n?.resolvedLanguage ?? i18n?.language ?? "en";
  const description = getAgentShareDescription(
    persona,
    t("share.descriptionFallback", { name: persona.displayName }),
  );
  const cardContentIdentity = [
    locale,
    persona.id,
    persona.avatar,
    persona.displayName,
    persona.systemPrompt,
    persona.sourceDescription,
    description,
  ].join("\0");

  useEffect(() => {
    if (!open) {
      cardOperationGenerationRef.current += 1;
      cardOperationAbortRef.current?.abort();
      cardOperationAbortRef.current = null;
      cardDownloadInFlightRef.current = null;
      agentDownloadInFlightRef.current = false;
      setCardDownloadPending(false);
      setAgentDownloadPending(false);
    }
    return () => {
      cardOperationGenerationRef.current += 1;
      cardOperationAbortRef.current?.abort();
      cardOperationAbortRef.current = null;
    };
  }, [open]);

  useLayoutEffect(() => {
    setFailedAvatarSources(new Set());
    setAvatarReadySrc(null);
    // Invalidate work before changed card content can paint or an old async
    // completion can commit.
    void cardContentIdentity;
    cardOperationGenerationRef.current += 1;
    cardOperationAbortRef.current?.abort();
    cardOperationAbortRef.current = null;
    cardDownloadInFlightRef.current = null;
    setCardDownloadPending(false);
  }, [cardContentIdentity]);

  useEffect(() => {
    if (!open || !avatarSrc || cardReady) return;
    const timeout = window.setTimeout(() => {
      setFailedAvatarSources((current) => {
        const next = new Set(current);
        next.add(avatarSrc);
        return next;
      });
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [avatarSrc, cardReady, open]);

  useEffect(() => {
    if (!open || !cachedAvatar) return;
    let cancelled = false;
    const poster = cachedAvatar.posterSrc
      ? Promise.resolve(cachedAvatar.posterSrc)
      : createAvatarPoster(cachedAvatar);
    void poster
      .then((src) => {
        if (!cancelled)
          setGeneratedAvatarPoster({ avatar: persona.avatar, src });
      })
      .catch((error) => {
        console.error("Failed to resolve avatar still:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [cachedAvatar, open, persona.avatar]);

  const handleDownloadCard = useCallback(
    async (format: "png" | "zip") => {
      if (cardDownloadInFlightRef.current !== null) return;
      const operationGeneration = cardOperationGenerationRef.current;
      const controller = new AbortController();
      cardDownloadInFlightRef.current = operationGeneration;
      cardOperationAbortRef.current = controller;
      setCardDownloadPending(true);
      try {
        // Render exactly what the reviewed card displays. Re-generating a second
        // poster here can produce a different or blank frame for stacked videos.
        const cardAvatarSrc = avatarReadySrc;
        if (!cardAvatarSrc) {
          throw new Error("Agent avatar is not ready");
        }
        const card = await renderAgentShareCard(
          persona,
          cardAvatarSrc,
          cardBase,
          locale,
          description,
        );
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        const embeddedAvatar = await avatarSourceToDataUrl(cardAvatarSrc);
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        const snapshot = personaToSnapshot({
          ...persona,
          avatar: embeddedAvatar ?? persona.avatar,
        });
        let animation = null;
        const stillMatchesAnimation = Boolean(
          cachedAvatar?.mediaType === "video" &&
            (cardAvatarSrc === currentGeneratedAvatarPoster ||
              cardAvatarSrc === cachedAvatar.posterSrc),
        );
        if (cachedAvatar?.mediaType === "video" && stillMatchesAnimation) {
          try {
            if (
              /^asset:/u.test(cachedAvatar.src) &&
              typeof persona.avatar === "string"
            ) {
              const avatarRef = persona.avatar;
              const cachedAnimation = await withAnimationEmbedDeadline(() =>
                readCachedAvatarAnimation({ avatarRef }),
              );
              if (cachedAnimation) {
                animation = {
                  bytes: new Uint8Array(cachedAnimation.bytes),
                  mimeType:
                    cachedAnimation.mimeType === "video/mp4"
                      ? ("video/mp4" as const)
                      : ("video/webm" as const),
                  alphaMode: cachedAnimation.alphaMode,
                };
              }
            } else if (/^(?:https?:|blob:|data:)/u.test(cachedAvatar.src)) {
              const blob = await withAnimationEmbedDeadline(async (signal) => {
                const response = await fetch(cachedAvatar.src, { signal });
                if (!response.ok)
                  throw new Error("Avatar animation request failed");
                return await response.blob();
              });
              if (blob.type !== "video/mp4" && blob.type !== "video/webm") {
                throw new Error(
                  "Avatar animation has an unsupported media type",
                );
              }
              const animationBytes = await blobToBytes(blob);
              const mimeType = blob.type as "video/mp4" | "video/webm";
              if (
                animationBytes.length <= MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES
              ) {
                animation = {
                  bytes: animationBytes,
                  mimeType,
                  alphaMode: cachedAvatar.alphaMode,
                };
              }
            }
          } catch (error) {
            console.warn("Could not embed animated avatar:", error);
          }
        }
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        const cardBytes = await blobToBytes(card);
        let encodedCard: Uint8Array;
        try {
          encodedCard = encodeAgentImage(cardBytes, snapshot, animation);
        } catch (error) {
          if (
            !(error instanceof AgentSnapshotError) ||
            error.code !== "too-large"
          ) {
            throw error;
          }
          // The still card remains portable when an otherwise-valid animation
          // would push the combined PNG over the snapshot size limit.
          encodedCard = encodeAgentImage(cardBytes, snapshot, null);
        }
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        const pngFilename = getAgentShareFilename(persona.displayName);
        const filename =
          format === "zip"
            ? pngFilename.replace(/\.png$/u, ".zip")
            : pngFilename;
        const downloadBytes =
          format === "zip"
            ? await createAgentZip(pngFilename, encodedCard, controller.signal)
            : encodedCard;
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        const blob = new Blob([new Uint8Array(downloadBytes).buffer], {
          type: format === "zip" ? "application/zip" : "image/png",
        });
        downloadBlob(blob, filename);
        toast.success(t("share.cardDownloaded", { filename }));
      } catch (error) {
        if (operationGeneration !== cardOperationGenerationRef.current) return;
        console.error("Failed to download agent share card:", error);
        toast.error(t("share.cardDownloadFailed"));
      } finally {
        if (cardDownloadInFlightRef.current === operationGeneration) {
          cardDownloadInFlightRef.current = null;
          if (cardOperationAbortRef.current === controller) {
            cardOperationAbortRef.current = null;
          }
          setCardDownloadPending(false);
        }
      }
    },
    [
      avatarReadySrc,
      cachedAvatar,
      cardBase,
      currentGeneratedAvatarPoster,
      description,
      locale,
      persona,
      t,
    ],
  );

  const handleAvatarPreloadRef = useCallback(
    (node: HTMLImageElement | null) => {
      avatarPreloadRef.current = node;
      if (!node || !avatarSrc) return;
      // Run after layout effects reset readiness for changed card content.
      queueMicrotask(() => {
        if (avatarPreloadRef.current !== node || !node.complete) return;
        if (node.naturalWidth > 0) setAvatarReadySrc(avatarSrc);
      });
    },
    [avatarSrc],
  );

  const handleDownloadAgent = useCallback(async () => {
    if (agentDownloadInFlightRef.current) return;
    agentDownloadInFlightRef.current = true;
    setAgentDownloadPending(true);
    try {
      await onDownloadAgent(persona);
    } finally {
      agentDownloadInFlightRef.current = false;
      setAgentDownloadPending(false);
    }
  }, [onDownloadAgent, persona]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        surface="solid"
        className="overflow-visible overflow-y-visible bg-card"
      >
        <DialogHeader>
          <DialogTitle>
            {t("share.title", { name: persona.displayName })}
          </DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative flex min-h-0 justify-center py-2 [perspective:1200px]">
          {avatarSrc ? (
            <img
              ref={handleAvatarPreloadRef}
              key={`preload:${avatarSrc}`}
              src={avatarSrc}
              alt=""
              aria-hidden="true"
              data-testid="agent-card-avatar-preload"
              className="absolute size-px opacity-0"
              onLoad={() => setAvatarReadySrc(avatarSrc)}
              onError={() => {
                setAvatarReadySrc(null);
                setFailedAvatarSources((current) => {
                  const next = new Set(current);
                  next.add(avatarSrc);
                  return next;
                });
              }}
            />
          ) : null}
          <AnimatePresence mode="wait" initial={false}>
            {avatarUnavailable ? (
              <motion.div
                key="avatar-unavailable"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
                className="flex aspect-[1227/1839] w-full max-w-[min(19rem,calc((100dvh-18rem)*0.6667))] items-center justify-center rounded-[6.5%] bg-card text-sm text-muted-foreground shadow-sm"
                role="status"
              >
                {t("share.avatarUnavailable")}
              </motion.div>
            ) : !cardReady ? (
              <motion.div
                key="loader"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
                className="flex aspect-[1227/1839] w-full max-w-[min(19rem,calc((100dvh-18rem)*0.6667))] items-center justify-center"
              >
                <Loader2
                  aria-label={t("share.loadingCard")}
                  className="size-8 animate-spin text-muted-foreground motion-reduce:animate-none"
                />
              </motion.div>
            ) : (
              <AgentCardReveal identity={cardContentIdentity}>
                <AgentShareCardPreview
                  identity={persona.id}
                  displayName={persona.displayName}
                  description={description}
                  avatarSrc={avatarSrc}
                  alt={t("share.cardAlt", { name: persona.displayName })}
                  locale={locale}
                />
              </AgentCardReveal>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter>
          {agentDownloadPending ? (
            <span
              className="sr-only"
              role="status"
              aria-live="polite"
              data-testid="agent-download-status"
            >
              {t("share.downloadingAgent")}
            </span>
          ) : null}
          <SplitButton
            size="default"
            activeActionId="png"
            menuTriggerLabel={t("share.downloadOptions")}
            menuLayer="modal"
            feedbackState={cardDownloadPending ? "loading" : "idle"}
            loadingLabel={t("share.downloadingCard")}
            actions={[
              {
                id: "png",
                label: t("share.downloadPng"),
                disabled: !cardReady || cardDownloadPending,
              },
              {
                id: "zip",
                label: t("share.downloadZip"),
                disabled: !cardReady || cardDownloadPending,
              },
              {
                id: "markdown",
                label: t("share.downloadMarkdown"),
                disabled: agentDownloadPending,
              },
            ]}
            onActionSelect={() => {}}
            onPrimaryClick={(action) => {
              if (action === "markdown") {
                void handleDownloadAgent();
              } else {
                void handleDownloadCard(action);
              }
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
