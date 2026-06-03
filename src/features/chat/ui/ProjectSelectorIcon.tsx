import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";

export function ProjectSelectorIcon({
  icon,
  color,
  projectId,
}: {
  icon?: string | null;
  color?: string | null;
  projectId?: string;
}) {
  if (!icon && !color && !projectId) {
    return (
      <span
        aria-hidden="true"
        className="inline-block size-2.5 rounded-full bg-muted-foreground/40"
      />
    );
  }

  return (
    <ProjectIcon
      icon={icon}
      color={color}
      projectId={projectId}
      className="size-3.5 rounded-[3px]"
      imageClassName="size-3.5 rounded-[3px]"
    />
  );
}
