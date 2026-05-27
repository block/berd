import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  Avatar as AvatarRoot,
  AvatarFallback,
  AvatarImage,
} from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { DetailField } from "@/shared/ui/detail-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageColumns } from "@/shared/ui/page-columns";
import { DetailPageShell, PageHeader } from "@/shared/ui/page-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { useAvatarImage } from "@/shared/hooks/useAvatarSrc";
import type { Persona } from "@/shared/types/agents";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  canDeletePersona,
  canEditPersona,
  getPersonaInitials,
  getPersonaProviderLabel,
  getPersonaSource,
} from "@/features/agents/lib/personaPresentation";

interface AgentDetailPageProps {
  persona: Persona;
  onBack: () => void;
  onEdit: (persona: Persona) => void;
  onDuplicate: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onExport: (persona: Persona) => void;
}

interface AgentHeaderActionButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
}

function AgentHeaderActionButton({
  label,
  icon,
  type = "button",
  ...props
}: AgentHeaderActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type={type}
          size="icon-xs"
          variant="outline-flat"
          aria-label={label}
          {...props}
        >
          {icon}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" sideOffset={8}>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function AgentDetailPage({
  persona,
  onBack,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
}: AgentDetailPageProps) {
  const { t } = useTranslation(["agents", "common"]);
  const acpProviders = useAgentStore((s) => s.providers);
  const avatarImage = useAvatarImage(persona.avatar);
  const initials = getPersonaInitials(persona.displayName);
  const personaSource = getPersonaSource(persona);
  const isEditable = canEditPersona(persona);
  const isDeletable = canDeletePersona(persona);
  const sourceLabel =
    personaSource === "builtin"
      ? t("common:labels.builtIn")
      : t("card.fileBacked");
  const providerLabel = getPersonaProviderLabel(
    persona.provider,
    acpProviders,
    t("common:labels.none"),
  );
  const modelLabel = persona.model || t("common:labels.none");
  const createdLabel = persona.createdAt ? formatDate(persona.createdAt) : null;
  const updatedLabel = persona.updatedAt ? formatDate(persona.updatedAt) : null;

  return (
    <DetailPageShell>
      <div className="space-y-5 border-b border-border pb-6">
        <Button
          type="button"
          variant="back"
          size="sm"
          className="w-fit"
          onClick={onBack}
        >
          {t("view.backToAgents")}
        </Button>

        <PageHeader
          variant="detail"
          title={
            <span className="inline-flex min-w-0 items-center gap-3">
              <AvatarRoot
                className={cn(
                  "size-12 shrink-0",
                  // The persona PNGs are transparent — skip the bordered
                  // muted backdrop when we have an image so the page surface
                  // shows through. Keep it for the initials fallback so the
                  // text has something behind it.
                  !avatarImage && "border border-border/80 bg-muted/30",
                )}
              >
                <AvatarImage src={avatarImage} alt={persona.displayName} />
                <AvatarFallback className="text-base font-semibold">
                  {initials}
                </AvatarFallback>
              </AvatarRoot>
              <span className="min-w-0 truncate">{persona.displayName}</span>
            </span>
          }
          description={persona.systemPrompt}
          descriptionClassName="line-clamp-2 max-w-3xl leading-relaxed"
          actionsPlacement="below"
          actions={
            <>
              {isEditable ? (
                <AgentHeaderActionButton
                  label={t("common:actions.edit")}
                  icon={<Pencil className="size-3.5" />}
                  onClick={() => onEdit(persona)}
                />
              ) : null}
              <AgentHeaderActionButton
                label={t("editor.duplicate")}
                icon={<Copy className="size-3.5" />}
                onClick={() => onDuplicate(persona)}
              />
              <AgentHeaderActionButton
                label={t("common:actions.export")}
                icon={<Download className="size-3.5" />}
                onClick={() => onExport(persona)}
              />
              {isDeletable ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="outline-flat"
                      aria-label={t("view.more")}
                    >
                      <MoreVertical className="size-3.5" />
                      <span className="sr-only">{t("view.more")}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    variant="inverse"
                    align="end"
                    sideOffset={8}
                  >
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onDelete(persona)}
                    >
                      <Trash2 className="size-3.5" />
                      {t("common:actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          }
          actionsClassName="gap-2"
        />
      </div>

      <PageColumns
        defaultSidebarSize={30}
        minSidebarSize={24}
        maxSidebarSize={38}
        minContentSize={52}
        sidebar={
          <aside className="space-y-5">
            <section className="space-y-5 border-b border-border pb-5">
              <DetailField label={t("view.source")}>
                <Badge variant="secondary">{sourceLabel}</Badge>
              </DetailField>

              <DetailField
                label={t("editor.provider")}
                contentAs="p"
                contentClassName="break-words"
              >
                {providerLabel}
              </DetailField>

              <DetailField
                label={t("editor.model")}
                contentAs="p"
                contentClassName="break-words"
              >
                {modelLabel}
              </DetailField>
            </section>

            {createdLabel || updatedLabel ? (
              <section className="space-y-5">
                {createdLabel ? (
                  <DetailField label={t("view.created")} contentAs="p">
                    {createdLabel}
                  </DetailField>
                ) : null}
                {updatedLabel ? (
                  <DetailField label={t("view.updated")} contentAs="p">
                    {updatedLabel}
                  </DetailField>
                ) : null}
              </section>
            ) : null}
          </aside>
        }
      >
        <section className="space-y-4 pb-6">
          <DetailField
            label={t("editor.systemPrompt")}
            meta={
              <span className="text-[10px] text-muted-foreground">
                {t("common:labels.characterCount", {
                  count: persona.systemPrompt.length,
                })}
              </span>
            }
          />
          <MessageResponse className="min-w-0 text-sm leading-6">
            {persona.systemPrompt || " "}
          </MessageResponse>
        </section>
      </PageColumns>
    </DetailPageShell>
  );
}
