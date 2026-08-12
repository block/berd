import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";

export function ProjectSelectorIcon({
  icon,
  color,
  projectId,
  size = "sm",
}: {
  icon?: string | null;
  color?: string | null;
  projectId?: string;
  size?: "sm" | "lg";
}) {
  const iconSizeClass = size === "lg" ? "size-4" : "size-3.5";
  const radiusClass = size === "lg" ? "rounded-[4px]" : "rounded-[3px]";
  const fallbackSizeClass = size === "lg" ? "size-3" : "size-2.5";

  if (!icon && !color && !projectId) {
    return (
      <span
        aria-hidden="true"
        className={`${fallbackSizeClass} inline-block rounded-full bg-muted-foreground/40`}
      />
    );
  }

  return (
    <ProjectIcon
      icon={icon}
      color={color}
      projectId={projectId}
      className={`${iconSizeClass} ${radiusClass}`}
      imageClassName={`${iconSizeClass} ${radiusClass}`}
    />
  );
}
