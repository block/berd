import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import { toast } from "sonner";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { AgentProfileLayout } from "@/features/agents/ui/AgentProfileLayout";
import { AgentIdentityRail } from "@/features/agents/ui/AgentIdentityRail";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { showRemoteSkill, type RemoteSkill } from "../api/skillMarketplace";
import { remoteSkillWebUrl } from "../lib/remoteSkillWebUrl";

interface RemoteSkillDetailPageProps {
  skill: RemoteSkill;
  installing: boolean;
  onInstall: (skill: RemoteSkill) => void;
}

const INSTRUCTIONS_LABEL_CLASS =
  "text-xs leading-4 font-medium text-surface-agent-profile-fg-muted";
const INSTRUCTIONS_PANEL_CLASS =
  "min-h-[24rem] w-full overflow-y-auto rounded-md bg-card p-4 text-sm leading-relaxed text-surface-agent-profile-fg lg:min-h-[29rem]";

/**
 * Detail view for a remote (discoverable) skill. Mirrors the installed-skill
 * `SkillDetailPage` — identity rail + instructions panel via
 * `AgentProfileLayout` — instead of a bespoke dialog, so discovery feels like
 * the rest of the app. Adds Install and "View on web" actions, and lazily
 * fetches the SKILL.md body. Back navigation is handled by the top-bar
 * breadcrumb, matching the installed-skill detail page (no on-page arrow).
 */
export function RemoteSkillDetailPage({
  skill,
  installing,
  onInstall,
}: RemoteSkillDetailPageProps) {
  const { t } = useTranslation(["skills", "common"]);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const marketplaceTemplate = useDistroStore(
    (state) => state.manifest.marketplace?.skillUrlTemplate,
  );
  const webUrl = remoteSkillWebUrl(marketplaceTemplate, skill.name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    showRemoteSkill(skill.name)
      .then((markdown) => {
        if (!cancelled) {
          setContent(markdown);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(formatAcpErrorMessage(error, t("discover.previewError")));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skill.name, t]);

  const handleViewOnWeb = () => {
    if (!webUrl) {
      return;
    }
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(webUrl))
      .catch((error) => {
        console.error("[remoteSkillDetail] openUrl failed:", error);
      });
  };

  const metadata = [
    ...(skill.author
      ? [{ label: t("discover.author"), value: skill.author }]
      : []),
    ...(skill.roles.length > 0
      ? [{ label: t("discover.roles"), value: skill.roles.join(" · ") }]
      : []),
    ...(skill.status
      ? [{ label: t("discover.status"), value: skill.status }]
      : []),
  ];

  const actions = (
    <>
      {skill.installed ? (
        <span className="inline-flex h-8 items-center gap-1 text-sm font-medium text-muted-foreground">
          <IconCheck className="size-4" aria-hidden="true" />
          {t("discover.installed")}
        </span>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          feedbackState={installing ? "loading" : "idle"}
          loadingLabel={t("discover.installing")}
          preserveWidth
          onClick={() => onInstall(skill)}
        >
          {t("discover.install")}
        </Button>
      )}
      {webUrl ? (
        <Button
          type="button"
          variant="ghost"
          flush
          size="sm"
          className="ml-2"
          onClick={handleViewOnWeb}
          rightIcon={<IconExternalLink />}
        >
          {t("discover.viewOnWeb")}
        </Button>
      ) : null}
    </>
  );

  return (
    <AgentProfileLayout
      animateSections={false}
      identityRail={
        <AgentIdentityRail
          className="pt-6"
          title={skill.name}
          description={skill.description}
          metadata={metadata}
          actions={actions}
        />
      }
    >
      <section
        className="space-y-3 pt-6"
        aria-labelledby="remote-skill-instructions"
      >
        <h2 id="remote-skill-instructions" className={INSTRUCTIONS_LABEL_CLASS}>
          {t("view.instructions")}
        </h2>
        <div className={INSTRUCTIONS_PANEL_CLASS}>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : content ? (
            <MessageResponse className="min-w-0 text-sm leading-relaxed">
              {content}
            </MessageResponse>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("discover.previewUnavailable")}
            </p>
          )}
        </div>
      </section>
    </AgentProfileLayout>
  );
}
