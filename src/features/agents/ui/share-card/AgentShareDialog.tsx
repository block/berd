import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Download, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Persona } from "@/shared/types/agents";
import { isSafePngAvatarDataUrl } from "@/shared/lib/avatarUrl";
import {
  encodeAgentImage,
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES,
  personaToSnapshot,
} from "@/features/agents/agent-snapshot";
import {
  useAvatarImage,
  useAvatarMediaState,
} from "@/shared/hooks/useAvatarSrc";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  HolographicAgentCard,
  holographicCardPresets,
} from "./HolographicAgentCard";
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
    const blob = await response.blob();
    if (blob.type && blob.type !== "image/png") return null;
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
  const { t } = useTranslation("agents");
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
  const cardDownloadInFlightRef = useRef(false);
  const agentDownloadInFlightRef = useRef(false);
  const cardOperationGenerationRef = useRef(0);
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
  // The card can render as soon as the exact still image it will display has
  // decoded. Cached animation/poster resolution may continue independently.
  const cardReady = Boolean(avatarSrc && avatarReadySrc === avatarSrc);
  const cardBase = getAgentShareCardBase(persona.id);
  const description = getAgentShareDescription(persona);
  const cardContentIdentity = [
    persona.id,
    persona.avatar,
    persona.displayName,
    persona.systemPrompt,
    persona.sourceDescription,
  ].join("\0");

  useEffect(() => {
    if (!open) {
      cardOperationGenerationRef.current += 1;
    }
    return () => {
      cardOperationGenerationRef.current += 1;
    };
  }, [open]);

  useLayoutEffect(() => {
    setFailedAvatarSources(new Set());
    setAvatarReadySrc(null);
    // Invalidate work before changed card content can paint or an old async
    // completion can commit.
    void cardContentIdentity;
    cardOperationGenerationRef.current += 1;
    cardDownloadInFlightRef.current = false;
    setCardDownloadPending(false);
  }, [cardContentIdentity]);

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

  const handleDownloadCard = useCallback(async () => {
    if (cardDownloadInFlightRef.current) return;
    cardDownloadInFlightRef.current = true;
    const operationGeneration = cardOperationGenerationRef.current;
    setCardDownloadPending(true);
    try {
      // Render exactly what the reviewed card displays. Re-generating a second
      // poster here can produce a different or blank frame for stacked videos.
      const cardAvatarSrc = avatarSrc;
      if (!cardAvatarSrc) {
        throw new Error("Agent avatar is not ready");
      }
      const card = await renderAgentShareCard(persona, cardAvatarSrc, cardBase);
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      const embeddedAvatar = await avatarSourceToDataUrl(cardAvatarSrc);
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      const snapshot = personaToSnapshot({
        ...persona,
        avatar: embeddedAvatar ?? persona.avatar,
      });
      let animation = null;
      if (cachedAvatar?.mediaType === "video") {
        try {
          const animationBytes = await fetch(cachedAvatar.src)
            .then((response) => response.blob())
            .then(blobToBytes);
          if (animationBytes.length <= MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES) {
            animation = {
              bytes: animationBytes,
              mimeType: cachedAvatar.src.toLowerCase().includes(".mp4")
                ? ("video/mp4" as const)
                : ("video/webm" as const),
              alphaMode: cachedAvatar.alphaMode,
            };
          }
        } catch (error) {
          console.warn("Could not embed animated avatar:", error);
        }
      }
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      const encodedCard = encodeAgentImage(
        await blobToBytes(card),
        snapshot,
        animation,
      );
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      const filename = getAgentShareFilename(persona.displayName);
      downloadBlob(
        new Blob([new Uint8Array(encodedCard).buffer], { type: "image/png" }),
        filename,
      );
      toast.success(t("share.cardDownloaded", { filename }));
    } catch (error) {
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      console.error("Failed to download agent share card:", error);
      toast.error(t("share.cardDownloadFailed"));
    } finally {
      cardDownloadInFlightRef.current = false;
      if (operationGeneration === cardOperationGenerationRef.current) {
        setCardDownloadPending(false);
      }
    }
  }, [avatarSrc, cachedAvatar, cardBase, persona, t]);

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
      <DialogContent size="lg" surface="solid" className="bg-card">
        <DialogHeader>
          <DialogTitle>
            {t("share.title", { name: persona.displayName })}
          </DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative flex min-h-[26rem] justify-center py-2 [perspective:1200px]">
          {avatarSrc ? (
            <img
              key={`preload:${avatarSrc}`}
              src={avatarSrc}
              alt=""
              aria-hidden="true"
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
            {!cardReady ? (
              <motion.div
                key="loader"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <Loader2
                  aria-label={t("share.loadingCard")}
                  className="size-8 animate-spin text-muted-foreground motion-reduce:animate-none"
                />
              </motion.div>
            ) : (
              <motion.div
                key={`card:${avatarSrc}`}
                initial={
                  shouldReduceMotion
                    ? false
                    : { opacity: 0, rotateY: -92, scale: 0.92 }
                }
                animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                transition={{
                  duration: shouldReduceMotion ? 0 : 0.45,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="w-full max-w-[19rem] [transform-style:preserve-3d]"
              >
                <HolographicAgentCard
                  src={cardBase}
                  settings={holographicCardPresets.rainbowPrism}
                  alt={t("share.cardAlt", { name: persona.displayName })}
                >
                  <div className="absolute inset-x-[8%] top-[7%] bottom-[8%] flex flex-col text-center text-agent-share-card-ink">
                    <h3 className="line-clamp-2 shrink-0 break-words pb-[0.08em] text-[clamp(1.5rem,5vw,2.6rem)] font-bold leading-[1.08] tracking-[-0.04em]">
                      {persona.displayName}
                    </h3>
                    <div className="flex min-h-0 flex-1 items-center justify-center px-[9%] py-[5%]">
                      <img
                        src={avatarSrc}
                        alt=""
                        aria-hidden="true"
                        className="max-h-full max-w-full object-contain drop-shadow-xl"
                      />
                    </div>
                    <p className="line-clamp-4 shrink-0 break-words text-center text-[12px] leading-snug">
                      {description}
                    </p>
                  </div>
                </HolographicAgentCard>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            leftIcon={
              cardDownloadPending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Download />
              )
            }
            disabled={cardDownloadPending}
            onClick={() => void handleDownloadCard()}
          >
            {t("share.downloadCard")}
          </Button>
          <Button
            type="button"
            variant="outline"
            leftIcon={
              agentDownloadPending ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Download />
              )
            }
            disabled={agentDownloadPending}
            onClick={() => void handleDownloadAgent()}
          >
            {t("share.downloadAgent", { name: persona.displayName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
