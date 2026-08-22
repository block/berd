import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { CreatePersonaRequest, ProviderType } from "@/shared/types/agents";
import { AgentImportPrimaryButton } from "@/shared/ui/agent-import-primary-button";
import { AgentImportSecondaryButton } from "@/shared/ui/agent-import-secondary-button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import type { SnapshotV1 } from "@/features/agents/agent-snapshot";
import { importUserAvatarDataUrl } from "@/shared/api/avatars";
import { decodeAvatarAnimation } from "@/features/agents/agent-snapshot";
import { isSafePngAvatarDataUrl } from "@/shared/lib/avatarUrl";
import { snapshotToCreatePersonaRequest } from "@/features/agents/agent-snapshot";
import { ProviderModelFields } from "@/features/agents/ui/PersonaFields/ProviderModelFields";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderModels } from "@/features/providers/hooks/useProviderModels";

function supportsConfiguration(
  provider: string,
  modelProviderId: string,
  model: string,
  providerIds: Set<string>,
  getModelsForAgent: (
    provider: string,
  ) => Array<{ id: string; providerId?: string }>,
): boolean {
  if (!provider && !model) return true;
  if (!provider || !providerIds.has(provider)) return false;
  return (
    !model ||
    getModelsForAgent(provider).some(
      (candidate) =>
        candidate.id === model &&
        (candidate.providerId ?? provider) === (modelProviderId || provider),
    )
  );
}

interface AgentImageImportDialogProps {
  snapshot: SnapshotV1;
  imageBytes: Uint8Array;
  onCancel: () => void;
  onConfirm: (request: CreatePersonaRequest) => Promise<void>;
}

export function AgentImageImportDialog({
  snapshot,
  imageBytes,
  onCancel,
  onConfirm,
}: AgentImageImportDialogProps) {
  const { t } = useTranslation("agents");
  const shouldReduceMotion = useReducedMotion();
  const { getModelsForAgent } = useProviderModels();
  const providers = useAgentStore((state) => state.providers);
  const providerIds = useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers],
  );
  const sourceProvider = snapshot.definition.provider?.trim() || "";
  const sourceModel = snapshot.definition.model?.trim() || "";
  const sourceModelProviderId =
    snapshot.definition.modelProviderId?.trim() || sourceProvider;
  const sourceConfigurationSupported = supportsConfiguration(
    sourceProvider,
    sourceModelProviderId,
    sourceModel,
    providerIds,
    getModelsForAgent,
  );
  const initialConfiguration = useMemo(() => {
    const supported = supportsConfiguration(
      sourceProvider,
      sourceModelProviderId,
      sourceModel,
      providerIds,
      getModelsForAgent,
    );
    return {
      name:
        snapshot.profile?.displayName?.trim() ||
        snapshot.definition.name?.trim() ||
        "",
      provider: supported ? sourceProvider : "",
      model: supported ? sourceModel : "",
      unsupported: !supported,
    };
  }, [
    getModelsForAgent,
    providerIds,
    snapshot,
    sourceModel,
    sourceModelProviderId,
    sourceProvider,
  ]);
  const [name, setName] = useState(initialConfiguration.name);
  const [provider, setProvider] = useState<ProviderType | "">(
    initialConfiguration.provider,
  );
  const [model, setModel] = useState(initialConfiguration.model);
  const [modelProviderId, setModelProviderId] = useState(
    initialConfiguration.model ? sourceModelProviderId : "",
  );
  const configurationEditedRef = useRef(false);
  const [pending, setPending] = useState(false);
  const embeddedAvatar = snapshot.profile?.avatarDataUrl;
  const safeEmbeddedAvatar =
    typeof embeddedAvatar === "string" && isSafePngAvatarDataUrl(embeddedAvatar)
      ? embeddedAvatar
      : null;
  const [fallbackImageUrl, setFallbackImageUrl] = useState<string | null>(null);
  const imageUrl = safeEmbeddedAvatar ?? fallbackImageUrl;
  const [bodyScrolled, setBodyScrolled] = useState(false);
  const containsIgnoredMemory =
    snapshot.memory != null &&
    (snapshot.memory.level !== "none" ||
      (snapshot.memory.entries?.length ?? 0) > 0);

  useEffect(() => {
    if (configurationEditedRef.current || !sourceConfigurationSupported) return;
    setProvider(sourceProvider);
    setModel(sourceModel);
    setModelProviderId(sourceModelProviderId);
  }, [
    sourceConfigurationSupported,
    sourceModel,
    sourceModelProviderId,
    sourceProvider,
  ]);

  useEffect(() => {
    if (safeEmbeddedAvatar) return;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(imageBytes).buffer], { type: "image/png" }),
    );
    setFallbackImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageBytes, safeEmbeddedAvatar]);

  const handleConfirm = async () => {
    if (!name.trim() || pending) return;
    setPending(true);
    try {
      const selectedConfigurationSupported = supportsConfiguration(
        provider,
        modelProviderId,
        model,
        providerIds,
        getModelsForAgent,
      );
      let animation = null;
      if (imageBytes) {
        try {
          animation = decodeAvatarAnimation(imageBytes);
        } catch {
          // Animation is an optional Berd extension; legacy test fixtures and
          // otherwise valid portable snapshots can import without it.
        }
      }
      let importedAnimationAvatar: string | undefined;
      if (animation) {
        let binary = "";
        for (
          let offset = 0;
          offset < animation.bytes.length;
          offset += 0x8000
        ) {
          binary += String.fromCharCode(
            ...animation.bytes.subarray(offset, offset + 0x8000),
          );
        }
        try {
          importedAnimationAvatar = await importUserAvatarDataUrl({
            dataUrl: `data:${animation.mimeType};base64,${btoa(binary)}`,
            alphaMode: animation.alphaMode,
            posterDataUrl:
              typeof snapshot.profile?.avatarDataUrl === "string"
                ? snapshot.profile.avatarDataUrl
                : undefined,
          });
        } catch {
          // Animation is optional. Preserve the portable still avatar when an
          // older or unsupported animation cannot be restored locally.
        }
      }
      try {
        await onConfirm({
          ...snapshotToCreatePersonaRequest(snapshot, {
            supportsConfiguration: () => false,
          }),
          displayName: name.trim(),
          provider: selectedConfigurationSupported
            ? provider || undefined
            : undefined,
          modelProviderId:
            selectedConfigurationSupported && provider && model
              ? modelProviderId || provider
              : undefined,
          model:
            selectedConfigurationSupported && provider && model
              ? model
              : undefined,
          // The outer PNG is the collectible card. Only the separately embedded
          // snapshot avatar is persisted as the agent avatar.
          avatar:
            importedAnimationAvatar ??
            snapshotToCreatePersonaRequest(snapshot).avatar,
        });
      } catch {
        // The imported gloopie is now a durable library asset, independent of
        // whether this agent can be created. The parent owns user-facing error
        // reporting; keep this click handler
        // settled so a failed create does not become an unhandled rejection.
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent
        size="lg"
        surface="solid"
        className="bg-card [&_[data-slot=dialog-close]]:z-20"
        aria-describedby={undefined}
      >
        <DialogHeader
          className="relative z-10 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-card after:to-transparent after:opacity-0 after:transition-opacity after:duration-150 data-[scrolled=true]:after:opacity-100"
          data-scrolled={bodyScrolled || undefined}
        >
          <DialogTitle>{t("imageImport.description")}</DialogTitle>
        </DialogHeader>
        <DialogBody
          className="space-y-5 pb-4"
          onScroll={(event) =>
            setBodyScrolled(event.currentTarget.scrollTop > 0)
          }
        >
          <div className="space-y-3">
            {imageUrl ? (
              <motion.img
                src={imageUrl}
                alt={t("imageImport.previewAlt")}
                initial={
                  shouldReduceMotion
                    ? false
                    : { scale: 1.38, opacity: 0.96, y: 8 }
                }
                animate={{ scale: 1, opacity: 1, y: 0 }}
                transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                className="mx-auto block max-h-52 max-w-52 object-contain drop-shadow-[0_10px_18px_rgba(36,36,36,0.12)] will-change-transform"
              />
            ) : null}
            <motion.div
              initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.3,
                delay: shouldReduceMotion ? 0 : 0.12,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="space-y-2"
            >
              <Label htmlFor="agent-image-name">{t("imageImport.name")}</Label>
              <Input
                id="agent-image-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                className="border-border bg-muted/40 dark:bg-background/35"
              />
            </motion.div>
          </div>
          <motion.div
            initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.32,
              delay: shouldReduceMotion ? 0 : 0.18,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="space-y-5"
          >
            {!sourceConfigurationSupported &&
            !configurationEditedRef.current ? (
              <p className="text-sm text-muted-foreground">
                {t("imageImport.unsupportedConfiguration")}
              </p>
            ) : null}
            <ProviderModelFields
              provider={provider}
              modelProviderId={modelProviderId}
              model={model}
              onProviderChange={(value) => {
                configurationEditedRef.current = true;
                setProvider(value);
              }}
              onModelChange={(selection) => {
                configurationEditedRef.current = true;
                setModel(selection?.modelId ?? "");
                setModelProviderId(selection?.modelProviderId ?? "");
              }}
              gridLayout
              classes={{
                sectionGap: "space-y-2",
                selectTrigger:
                  "border-border bg-muted/40 dark:bg-background/35",
              }}
            />
            {containsIgnoredMemory ? (
              <p className="text-sm text-muted-foreground">
                {t("imageImport.memoryIgnored")}
              </p>
            ) : null}
            <section className="space-y-2">
              <Label htmlFor="agent-image-instructions">
                {t("view.instructions")}
              </Label>
              <Textarea
                id="agent-image-instructions"
                readOnly
                value={
                  snapshot.definition.systemPrompt ||
                  t("imageImport.noInstructions")
                }
                className="h-20 min-h-20 resize-none overflow-y-scroll border-border bg-muted/40 dark:bg-background/35"
              />
            </section>
          </motion.div>
        </DialogBody>
        <DialogFooter>
          <AgentImportSecondaryButton
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            {t("imageImport.cancel")}
          </AgentImportSecondaryButton>
          <AgentImportPrimaryButton
            type="button"
            disabled={!name.trim() || pending}
            onClick={() => void handleConfirm()}
          >
            {pending ? t("imageImport.adding") : t("imageImport.add")}
          </AgentImportPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
