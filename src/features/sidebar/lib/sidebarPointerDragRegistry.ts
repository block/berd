export type SidebarChatDropTargetKind = "project" | "project-group" | "recents";

export interface SidebarChatDropTarget {
  kind: SidebarChatDropTargetKind;
  projectId: string | null;
  rect: DOMRect;
}

export interface SidebarProjectReorderTarget {
  projectId: string;
  rect: DOMRect;
}

export function findSidebarChatDropTarget<T extends SidebarChatDropTarget>(
  targets: T[],
  clientX: number,
  clientY: number,
): T | null {
  return (
    targets.find(
      (target) =>
        clientX >= target.rect.left &&
        clientX <= target.rect.right &&
        clientY >= target.rect.top &&
        clientY <= target.rect.bottom,
    ) ?? null
  );
}

export function findSidebarProjectReorderTarget(
  targets: SidebarProjectReorderTarget[],
  draggedProjectId: string,
  clientX: number,
  clientY: number,
): { projectId: string; placement: "before" | "after" } | null {
  const target = targets.find(
    (candidate) =>
      candidate.projectId !== draggedProjectId &&
      clientX >= candidate.rect.left &&
      clientX <= candidate.rect.right &&
      clientY >= candidate.rect.top &&
      clientY <= candidate.rect.bottom,
  );

  if (!target) {
    return null;
  }

  return {
    projectId: target.projectId,
    placement:
      clientY - target.rect.top > target.rect.height / 2 ? "after" : "before",
  };
}
