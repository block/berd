import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { VoiceInterruptionSensitivity } from "../lib/voiceInterruptionPreference";
import { useVoiceInterruptionPreference } from "../lib/voiceInterruptionPreference";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

const SENSITIVITIES: VoiceInterruptionSensitivity[] = [
  "less",
  "balanced",
  "more",
];

export function AdvancedVoiceDetectionDialog() {
  const { t } = useTranslation("settings");
  const interruption = useVoiceInterruptionPreference();
  const conversationActive = useVoiceConversationStore(
    (state) => state.status.lifecycle === "running",
  );
  const speechHeadingId = useId();
  const speechDescriptionId = useId();
  const interruptionHeadingId = useId();
  const interruptionDescriptionId = useId();

  const reset = () => interruption.resetSensitivities();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t("voice.advancedDetection.open")}
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        closeLabel={t("actions.close", { ns: "common" })}
      >
        <DialogHeader>
          <DialogTitle>{t("voice.advancedDetection.title")}</DialogTitle>
          <DialogDescription>
            {t("voice.advancedDetection.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          <div className="space-y-2">
            <div>
              <h3 id={speechHeadingId} className="text-sm font-medium">
                {t("voice.advancedDetection.speechSensitivity")}
              </h3>
              <p
                id={speechDescriptionId}
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {t(
                  conversationActive
                    ? "voice.advancedDetection.speechSensitivityActiveDescription"
                    : "voice.advancedDetection.speechSensitivityDescription",
                )}
              </p>
            </div>
            <Select
              value={interruption.speechSensitivity}
              disabled={conversationActive}
              onValueChange={(value) =>
                interruption.setSpeechSensitivity(
                  value as VoiceInterruptionSensitivity,
                )
              }
            >
              <SelectTrigger
                className="w-full"
                aria-labelledby={speechHeadingId}
                aria-describedby={speechDescriptionId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SENSITIVITIES.map((sensitivity) => (
                  <SelectItem key={sensitivity} value={sensitivity}>
                    {t(
                      `voice.advancedDetection.sensitivityOptions.${sensitivity}`,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {interruption.mode !== "preventFeedback" ? (
            <div className="space-y-2">
              <div>
                <h3 id={interruptionHeadingId} className="text-sm font-medium">
                  {t("voice.advancedDetection.interruptionSensitivity")}
                </h3>
                <p
                  id={interruptionDescriptionId}
                  className="mt-0.5 text-xs text-muted-foreground"
                >
                  {t(
                    "voice.advancedDetection.interruptionSensitivityDescription",
                  )}
                </p>
              </div>
              <Select
                value={interruption.sensitivity}
                onValueChange={(value) =>
                  interruption.setSensitivity(
                    value as VoiceInterruptionSensitivity,
                  )
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby={interruptionHeadingId}
                  aria-describedby={interruptionDescriptionId}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENSITIVITIES.map((sensitivity) => (
                    <SelectItem key={sensitivity} value={sensitivity}>
                      {t(
                        `voice.advancedDetection.sensitivityOptions.${sensitivity}`,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            flush
            className="sm:mr-auto"
            disabled={conversationActive}
            onClick={reset}
          >
            {t("voice.advancedDetection.reset")}
          </Button>
          <DialogClose asChild>
            <Button type="button">{t("voice.advancedDetection.done")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
