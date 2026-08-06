import {
  IconCheck,
  IconRefresh,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GLOOPIE_PROMPT_MAX_LENGTH } from "@/shared/api/gloopies";
import { gloopieErrorMessageKey } from "@/features/agents/stores/gloopieGenerationStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Spinner } from "@/shared/ui/spinner";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { useAvatarMediaState } from "@/shared/hooks/useAvatarSrc";
import { GloopieGenerationHero } from "@/features/agents/ui/GloopieGenerationHero";
import type {
  GloopieGenerationState,
  GloopieOption,
} from "@/features/agents/hooks/useGloopieGeneration";

interface GloopieAvatarCreatorProps {
  state: GloopieGenerationState;
  /** Let generation continue in the background while the user edits the agent. */
  onContinueSetup: () => void;
  /** Abandon the current attempt and return to agent setup. */
  onDiscard: () => void;
}

/**
 * "Create your own" gloopie flow.
 *
 * States mirror the DAIM backend flow: prompt -> generating -> choose one of
 * four -> animating -> done. The native app uses the production integration;
 * non-Tauri test surfaces use the fallback in `useGloopieGeneration`.
 *
 * The "done" phase renders nothing here: the user already picked this option
 * from the four, so the builder rail commits a finished gloopie straight onto
 * the agent instead of asking again via a review step.
 *
 * There is no in-panel "browse existing" affordance: the surrounding header's
 * back button returns the user to the "Choose an avatar" list.
 */
export function GloopieAvatarCreator({
  state,
  onContinueSetup,
  onDiscard,
}: GloopieAvatarCreatorProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Which destructive action is awaiting an "are you sure": cancelling an
  // in-flight step, or throwing away generated options / the finished result.
  const [confirmAction, setConfirmAction] = useState<
    "discard" | "startOver" | null
  >(null);

  const onConfirmDestructive = () => {
    setConfirmAction(null);
    if (confirmAction === "discard") {
      onDiscard();
      return;
    }
    if (confirmAction === "startOver") {
      state.reset({ keepObject: true });
    }
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-xl flex-col gap-3">
      {state.phase === "prompt" ? <PromptStep state={state} /> : null}

      {state.phase === "generating" ? (
        <WaitingStep
          title={t("gloopie.generatingTitle")}
          body={t("gloopie.generatingBody")}
          sampleAvatarRef={state.sampleAvatarRef}
          onContinueSetup={onContinueSetup}
          onDiscard={() => setConfirmAction("discard")}
        />
      ) : null}

      {state.phase === "choosing" ? (
        <ChooseStep
          state={state}
          onStartOver={() => setConfirmAction("startOver")}
        />
      ) : null}

      {state.phase === "animating" ? (
        <WaitingStep
          title={t("gloopie.animatingTitle")}
          body={t("gloopie.animatingBody")}
          sampleAvatarRef={state.sampleAvatarRef}
          onContinueSetup={onContinueSetup}
          onDiscard={() => setConfirmAction("discard")}
        />
      ) : null}

      {/* "done" intentionally renders nothing: the rail auto-commits the
          finished gloopie and closes this surface. */}

      {state.phase === "error" ? <PromptStep state={state} /> : null}

      {/* "Are you sure" guarding the destructive actions above. Cancelling an
          in-flight step and starting over both delete generated media, so
          neither fires from a single click. */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmAction(null);
          }
        }}
        title={
          confirmAction === "discard"
            ? t("gloopie.confirmCancelTitle")
            : t("gloopie.confirmStartOverTitle")
        }
        description={
          confirmAction === "discard"
            ? t("gloopie.confirmCancelBody")
            : t("gloopie.confirmStartOverBody")
        }
        cancelLabel={t("gloopie.confirmKeep")}
        confirmLabel={
          confirmAction === "discard"
            ? t("gloopie.confirmCancelAction")
            : t("gloopie.confirmStartOverAction")
        }
        onConfirm={onConfirmDestructive}
      />
    </div>
  );
}

function PromptStep({ state }: { state: GloopieGenerationState }) {
  const { t } = useTranslation(["agents", "common"]);
  const canGenerate = state.object.trim().length > 0;
  const errorMessage =
    state.phase === "error" ? t(gloopieErrorMessageKey(state.errorCode)) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex justify-center py-2">
        <GloopieGenerationHero
          title={t("gloopie.promptTitle")}
          description={t("gloopie.promptHelp")}
          sampleAvatarRef={state.sampleAvatarRef}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="gloopie-object" className="text-sm text-foreground">
          {t("gloopie.promptLabel")}
        </Label>
        <Input
          id="gloopie-object"
          value={state.object}
          maxLength={GLOOPIE_PROMPT_MAX_LENGTH}
          placeholder={t("gloopie.promptPlaceholder")}
          aria-invalid={errorMessage ? true : undefined}
          aria-describedby={errorMessage ? "gloopie-object-error" : undefined}
          onChange={(event) => state.setObject(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canGenerate) {
              event.preventDefault();
              state.startGenerate();
            }
          }}
        />
        {errorMessage ? (
          <p
            id="gloopie-object-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </p>
        ) : null}
      </div>

      <Button
        type="button"
        variant="primary"
        className="w-full"
        disabled={!canGenerate}
        leftIcon={state.phase === "error" ? <IconRefresh /> : <IconWand />}
        onClick={state.startGenerate}
      >
        {state.phase === "error"
          ? t("gloopie.tryAgain")
          : t("gloopie.generateAction")}
      </Button>
    </div>
  );
}

function WaitingStep({
  title,
  body,
  sampleAvatarRef,
  onContinueSetup,
  onDiscard,
}: {
  title: string;
  body: string;
  sampleAvatarRef: string | null;
  onContinueSetup: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
      <GloopieGenerationHero
        title={title}
        description={body}
        sampleAvatarRef={sampleAvatarRef}
        animated
      />
      {/*
        This does not cancel the backend generation — that request runs to
        completion on the service. It abandons the attempt and deletes whatever
        media it produces, so the label promises discarding, not stopping.
      */}
      <div className="flex w-full max-w-xs flex-col items-stretch gap-2">
        <Button type="button" variant="primary" onClick={onContinueSetup}>
          {t("gloopie.continueAgentSetup")}
        </Button>
        {/* No icon: a trashcan read as "delete" and an x adds nothing the
            label doesn't already say. */}
        <Button type="button" variant="ghost" destructive onClick={onDiscard}>
          {t("gloopie.cancelGeneration")}
        </Button>
      </div>
    </div>
  );
}

function ChooseStep({
  state,
  onStartOver,
}: {
  state: GloopieGenerationState;
  onStartOver: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const hasChoice = state.chosenOptionId !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="space-y-1.5">
        <h3 className="text-base text-foreground">
          {t("gloopie.chooseTitle")}
        </h3>
        <p className="whitespace-pre-line text-sm text-muted-foreground">
          {t("gloopie.chooseHelp")}
        </p>
      </div>

      <fieldset className="mx-auto grid min-h-0 w-full max-w-[28rem] flex-1 grid-cols-2 grid-rows-2 gap-2">
        <legend className="sr-only">{t("gloopie.optionsGroupLabel")}</legend>
        {state.options.map((option, index) => (
          <GloopieOptionTile
            key={option.id}
            option={option}
            index={index}
            total={state.options.length}
            selected={state.chosenOptionId === option.id}
            // Clicking the highlighted option again releases the selection.
            onSelect={() =>
              state.chooseOption(
                state.chosenOptionId === option.id ? null : option.id,
              )
            }
          />
        ))}
      </fieldset>

      <div className="flex shrink-0 flex-col gap-2">
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={!hasChoice}
          onClick={state.animate}
        >
          {t("gloopie.useThisOne")}
        </Button>
        <div className="flex items-center justify-center gap-5">
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconRefresh />}
            onClick={state.regenerate}
          >
            {t("gloopie.regenerate")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            flush
            destructive
            leftIcon={<IconTrash />}
            onClick={onStartOver}
          >
            {t("gloopie.quitGeneration")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GloopieOptionTile({
  option,
  index,
  total,
  selected,
  onSelect,
}: {
  option: GloopieOption;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const media = useAvatarMediaState(option.avatarRef);

  return (
    <button
      type="button"
      className={cn(
        "relative flex min-h-0 items-center justify-center overflow-hidden rounded-md p-2 transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted/60",
      )}
      aria-label={t("gloopie.optionLabel", { index: index + 1, total })}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {media.media ? (
        <AvatarMedia
          media={media.media}
          alt=""
          lazy
          loadingStrategy="visible-video"
          className="h-full w-full object-contain"
        />
      ) : (
        <Spinner className="size-4 text-muted-foreground" />
      )}
      {selected ? (
        <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <IconCheck className="size-3" />
        </span>
      ) : null}
    </button>
  );
}
