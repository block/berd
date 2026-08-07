import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Persona } from "@/shared/types/agents";
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
import { HolographicAgentCard } from "./HolographicAgentCard";
import {
  createAvatarPoster,
  downloadBlob,
  getAgentShareCardBase,
  getAgentShareDescription,
  getAgentShareFilename,
  renderAgentShareCard,
} from "./agentShareCard";

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
  const [cardDownloadPending, setCardDownloadPending] = useState(false);
  const [agentDownloadPending, setAgentDownloadPending] = useState(false);
  const [generatedAvatarPoster, setGeneratedAvatarPoster] = useState<{
    avatar: Persona["avatar"];
    src: string;
  } | null>(null);
  const cardDownloadInFlightRef = useRef(false);
  const agentDownloadInFlightRef = useRef(false);
  const cardOperationGenerationRef = useRef(0);
  const agentOperationGenerationRef = useRef(0);
  const resolvedAvatar = useAvatarImage(persona.avatar);
  const cachedAvatar = useAvatarMediaState(persona.avatar).media;
  const fallbackAvatarSrc = resolveAgentIcon(persona.id);
  const currentGeneratedAvatarPoster =
    generatedAvatarPoster && generatedAvatarPoster.avatar === persona.avatar
      ? generatedAvatarPoster.src
      : undefined;
  const avatarSrc =
    resolvedAvatar ??
    currentGeneratedAvatarPoster ??
    cachedAvatar?.posterSrc ??
    fallbackAvatarSrc;
  const cardBase = getAgentShareCardBase(persona.id);
  const description = getAgentShareDescription(persona);

  useEffect(() => {
    if (!open) {
      cardOperationGenerationRef.current += 1;
      agentOperationGenerationRef.current += 1;
    }
    return () => {
      cardOperationGenerationRef.current += 1;
      agentOperationGenerationRef.current += 1;
    };
  }, [open]);

  useLayoutEffect(() => {
    // Reading the identity here makes this layout effect invalidate work before
    // a changed avatar can paint or an old async completion can commit.
    void persona.avatar;
    cardOperationGenerationRef.current += 1;
    cardDownloadInFlightRef.current = false;
    setCardDownloadPending(false);
  }, [persona.avatar]);

  useEffect(() => {
    if (!open || !cachedAvatar || cachedAvatar.posterSrc) return;
    let cancelled = false;
    void createAvatarPoster(cachedAvatar)
      .then((poster) => {
        if (!cancelled) {
          setGeneratedAvatarPoster({ avatar: persona.avatar, src: poster });
        }
      })
      .catch((error) => {
        console.error("Failed to create generated avatar poster:", error);
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
      const cardAvatarSrc = cachedAvatar
        ? await createAvatarPoster(cachedAvatar)
        : avatarSrc;
      const card = await renderAgentShareCard(persona, cardAvatarSrc, cardBase);
      if (operationGeneration !== cardOperationGenerationRef.current) return;
      const filename = getAgentShareFilename(persona.displayName);
      downloadBlob(card, filename);
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
    const operationGeneration = agentOperationGenerationRef.current;
    setAgentDownloadPending(true);
    try {
      await onDownloadAgent(persona);
    } finally {
      agentDownloadInFlightRef.current = false;
      if (operationGeneration === agentOperationGenerationRef.current) {
        setAgentDownloadPending(false);
      }
    }
  }, [onDownloadAgent, persona]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {t("share.title", { name: persona.displayName })}
          </DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex justify-center py-2 [perspective:1200px]">
          <div className="w-full max-w-[19rem]">
            <HolographicAgentCard
              src={cardBase}
              alt={t("share.cardAlt", { name: persona.displayName })}
            >
              <div className="absolute inset-x-[8%] top-[7%] bottom-[8%] flex flex-col text-center text-[#43005c]">
                <h3 className="line-clamp-2 shrink-0 break-words text-[clamp(1.5rem,5vw,2.6rem)] font-bold leading-[0.98] tracking-[-0.04em]">
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
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            leftIcon={<Download />}
            disabled={cardDownloadPending}
            onClick={() => void handleDownloadCard()}
          >
            {cardDownloadPending
              ? t("share.downloadingCard")
              : t("share.downloadCard")}
          </Button>
          <Button
            type="button"
            variant="primary"
            leftIcon={<Download />}
            disabled={agentDownloadPending}
            onClick={() => void handleDownloadAgent()}
          >
            {agentDownloadPending
              ? t("share.downloadingAgent")
              : t("share.downloadAgent", { name: persona.displayName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
