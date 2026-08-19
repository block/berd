import { IconLibraryPlusFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ChatInputSelector } from "./ChatInputSelector";
import { ProjectSelectorIcon } from "./ProjectSelectorIcon";
import type { ChatInputProjectPicker, ProjectOption } from "../types";

const NO_PROJECT_VALUE = "__no_project__";
const CREATE_PROJECT_VALUE = "__create_project__";

interface ProjectInputSelectorProps {
  selectedProjectId?: string | null;
  availableProjects?: ProjectOption[];
  onProjectChange?: (projectId: string | null) => void;
  onCreateProject?: ChatInputProjectPicker["onCreateProject"];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestComposerFocus?: () => void;
  triggerTabIndex?: number;
  triggerIconOnly?: boolean;
  triggerVariant?: "default" | "toolbar";
  triggerSize?: "default" | "sm";
  contentWidth?: "trigger" | "wide";
  contentSide?: "top" | "right" | "bottom" | "left";
  contentAlign?: "start" | "center" | "end";
  disabled?: boolean;
  modal?: boolean;
}

export function ProjectInputSelector({
  selectedProjectId = null,
  availableProjects = [],
  onProjectChange,
  onCreateProject,
  open,
  onOpenChange,
  onRequestComposerFocus,
  triggerTabIndex,
  triggerVariant = "toolbar",
  triggerSize = "default",
  contentWidth = "wide",
  contentSide,
  contentAlign,
  disabled,
  modal,
  triggerIconOnly,
}: ProjectInputSelectorProps) {
  const { t } = useTranslation("chat");
  const selectedProject =
    availableProjects.find((project) => project.id === selectedProjectId) ??
    null;
  const projectTitle = selectedProject?.workingDirs.length
    ? selectedProject.workingDirs.join(", ")
    : undefined;
  const triggerTitle = selectedProject
    ? projectTitle
      ? `${selectedProject.name} - ${projectTitle}`
      : selectedProject.name
    : t("toolbar.noProject");

  const handleValueChange = (value: string) => {
    if (value === CREATE_PROJECT_VALUE) {
      onCreateProject?.();
      return;
    }

    onProjectChange?.(value === NO_PROJECT_VALUE ? null : value);
  };

  return (
    <ChatInputSelector
      ariaLabel={t("toolbar.selectProject")}
      value={selectedProjectId ?? NO_PROJECT_VALUE}
      triggerLabel={selectedProject?.name ?? t("toolbar.noProject")}
      triggerTitle={triggerTitle}
      icon={
        <ProjectSelectorIcon
          icon={selectedProject?.icon}
          color={selectedProject?.color}
          projectId={selectedProject?.id}
          size="lg"
        />
      }
      open={open}
      onOpenChange={onOpenChange}
      onRequestComposerFocus={onRequestComposerFocus}
      triggerTabIndex={triggerTabIndex}
      triggerIconOnly={triggerIconOnly}
      triggerVariant={triggerVariant}
      triggerSize={triggerSize}
      menuLabel={t("toolbar.chooseProject")}
      contentWidth={contentWidth}
      contentSide={contentSide}
      contentAlign={contentAlign}
      disabled={disabled}
      modal={modal}
      sections={[
        {
          items: [
            {
              value: NO_PROJECT_VALUE,
              label: t("toolbar.noProject"),
              description: t("toolbar.generalChatWithoutProject"),
              icon: <ProjectSelectorIcon />,
            },
            ...availableProjects.map((project) => ({
              value: project.id,
              label: project.name,
              description: project.workingDirs.length
                ? project.workingDirs.join(", ")
                : undefined,
              icon: (
                <ProjectSelectorIcon
                  icon={project.icon}
                  color={project.color}
                  projectId={project.id}
                />
              ),
            })),
          ],
        },
        {
          items: [
            ...(onCreateProject
              ? [
                  {
                    value: CREATE_PROJECT_VALUE,
                    label: t("toolbar.createProject"),
                    icon: (
                      <IconLibraryPlusFilled className="size-4 text-foreground" />
                    ),
                  },
                ]
              : []),
          ],
        },
      ].filter((section) => section.items.length > 0)}
      onValueChange={handleValueChange}
      preservesExternalFocus={(value) => value === CREATE_PROJECT_VALUE}
    />
  );
}
