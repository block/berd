import { useEffect, useRef, useState } from "react";
import { IconInfoCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  recordAssistiveMomentAccepted,
  recordAssistiveMomentRetired,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

const MOMENT_ID = ASSISTIVE_UX_RULES.sidebarProjectsInfo.id;

export interface SidebarProjectsInfoMoment {
  /** Whether the info affordance should render at all. */
  visible: boolean;
  open: boolean;
  onOpenChange: (nextOpen: boolean) => void;
}

/**
 * Lifecycle for the one-time "what are projects?" discover moment. Owns
 * eligibility, exposure recording, and retirement so the call site can skip
 * rendering (and reserving layout space for) the affordance entirely when the
 * moment is not visible. Retires once opened, once the user has created a
 * project, or after enough exposures.
 *
 * `projectsReady` must reflect an authoritative project fetch (not the
 * localStorage seed): until it is true the moment neither renders, records,
 * nor retires, so a stale cache cannot permanently retire the guidance and a
 * missing cache cannot flash it at a user who does have projects. If the
 * fetch never succeeds the moment simply stays undecided.
 */
export function useSidebarProjectsInfoMoment({
  hasProjects,
  projectsReady,
}: {
  hasProjects: boolean;
  projectsReady: boolean;
}): SidebarProjectsInfoMoment {
  const [eligible, setEligible] = useState(() =>
    shouldShowAssistiveMoment(MOMENT_ID),
  );
  const [open, setOpen] = useState(false);

  const visible = projectsReady && eligible && !hasProjects;

  useEffect(() => {
    if (!projectsReady || !eligible || !hasProjects) return;
    // The user already has projects; this guidance is no longer needed.
    recordAssistiveMomentRetired(MOMENT_ID, "settingsChanged");
    setEligible(false);
  }, [projectsReady, eligible, hasProjects]);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      recordAssistiveMomentAccepted(MOMENT_ID);
    } else {
      // Opened and closed: the moment is done, hide the affordance.
      setEligible(false);
    }
  };

  return { visible, open, onOpenChange };
}

/**
 * One-time discover affordance next to the Projects section header that
 * explains what projects are. Render only while the accompanying
 * `useSidebarProjectsInfoMoment` reports `visible`. Exposure is recorded
 * here, on mount, rather than in the hook: the hook also runs when the
 * sidebar is hidden or the Projects header is not rendered, and those hidden
 * passes must not consume the moment's limited exposures.
 */
export function SidebarProjectsInfoButton({
  moment,
}: {
  moment: SidebarProjectsInfoMoment;
}) {
  const { t } = useTranslation("sidebar");
  const recordedShownRef = useRef(false);

  useEffect(() => {
    if (recordedShownRef.current) return;
    recordedShownRef.current = true;
    recordAssistiveMomentShown(MOMENT_ID);
  }, []);

  return (
    <Popover open={moment.open} onOpenChange={moment.onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          flush
          size="icon-xs"
          aria-label={t("projectsInfo.label")}
          title={moment.open ? undefined : t("projectsInfo.tooltip")}
          className="size-5"
        >
          <IconInfoCircle className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-64">
        <p className="text-sm font-medium">{t("projectsInfo.title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("projectsInfo.body")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
