import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  type ActiveSessionFeedbackSurvey,
  isSessionFeedbackSurveyActive,
  markSessionFeedbackSurveyAppeared,
  recordSessionFeedbackSurveyResponse,
  type SessionFeedbackSurveyResponse,
} from "./sessionFeedbackSurveyState";

export function SessionFeedbackSurvey({
  sessionId,
  survey,
}: {
  sessionId: string;
  survey: ActiveSessionFeedbackSurvey;
}) {
  const { t } = useTranslation("chat");
  const targetRef = useRef<HTMLFieldSetElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const intersectingRef = useRef(false);
  const focusedRef = useRef(false);
  const [visible, setVisible] = useState(() =>
    isSessionFeedbackSurveyActive(sessionId, survey.appearanceId),
  );

  useEffect(() => {
    const target = targetRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const isIntersecting = entries.some((entry) => entry.isIntersecting);
      intersectingRef.current = isIntersecting;
      if (isIntersecting) {
        markSessionFeedbackSurveyAppeared(sessionId, survey.appearanceId);
        if (!focusedRef.current) {
          dismissRef.current?.focus({ preventScroll: true });
          focusedRef.current = true;
        }
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [sessionId, survey.appearanceId]);

  const respond = useCallback(
    (response: SessionFeedbackSurveyResponse) => {
      recordSessionFeedbackSurveyResponse(
        sessionId,
        survey.appearanceId,
        response,
      );
      setVisible(false);
    },
    [sessionId, survey.appearanceId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        intersectingRef.current &&
        targetRef.current?.contains(document.activeElement)
      ) {
        respond("dismissed");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [respond]);

  if (!visible) return null;
  return (
    <fieldset
      ref={targetRef}
      className="mt-4 rounded-lg border border-border bg-muted/40 p-3"
    >
      <legend className="mb-2 text-sm font-medium">
        {t("message.sessionFeedbackQuestion")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["good", t("message.sessionFeedbackGood")],
            ["fine", t("message.sessionFeedbackFine")],
            ["bad", t("message.sessionFeedbackBad")],
          ] as const
        ).map(([response, label]) => (
          <Button
            key={response}
            size="sm"
            variant="outline"
            onClick={() => respond(response)}
          >
            {label}
          </Button>
        ))}
        <Button
          ref={dismissRef}
          size="sm"
          variant="ghost"
          onClick={() => respond("dismissed")}
        >
          {t("message.sessionFeedbackDismiss")}
        </Button>
      </div>
    </fieldset>
  );
}
