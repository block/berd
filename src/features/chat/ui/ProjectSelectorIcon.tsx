import { ProjectColorSwatch } from "@/features/projects/ui/ProjectColorSwatch";

export function ProjectSelectorIcon({
  color,
  projectId,
}: {
  color?: string | null;
  projectId?: string;
}) {
  if (!color && !projectId) {
    return (
      <span
        aria-hidden="true"
        className="relative top-0.5 inline-block size-2 rounded-full bg-muted-foreground/40"
      />
    );
  }

  return (
    <ProjectColorSwatch
      color={color}
      projectId={projectId}
      className="relative top-0.5"
    />
  );
}
