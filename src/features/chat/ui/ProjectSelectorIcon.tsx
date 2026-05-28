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
        className="relative top-0.5 inline-block size-2 rounded-full bg-muted-foreground/40"
      />
    );
  }

  return (
    <ProjectIcon
      icon={icon}
      color={color}
      projectId={projectId}
      className="relative top-0.5 size-3 rounded-[3px]"
      imageClassName="relative top-0.5 size-3 rounded-[3px]"
    />
  );
}
