import { Check, LayoutGrid, List, ListFilter, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProjectIcon } from "@/features/projects/ui/ProjectIcon";
import {
  NO_PROJECT_FILTER_ID,
  type SessionScope,
} from "@/features/sessions/lib/sessionListFilters";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";

export interface SessionListControlsProject {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

export type SessionListView = "list" | "grid";

export interface SessionListControlsProps {
  scope: SessionScope;
  onScopeChange: (scope: SessionScope) => void;
  /** When provided, shown as a count in the Archived tab label. */
  archivedCount?: number;
  projects: SessionListControlsProject[];
  selectedProjectIds: ReadonlySet<string>;
  onSelectedProjectIdsChange: (next: Set<string>) => void;
  /** Show a "No project" filter item wired to `NO_PROJECT_FILTER_ID`. */
  showNoProject?: boolean;
  view: SessionListView;
  onViewChange: (view: SessionListView) => void;
}

/**
 * Stateless controls row for the session history list: an Active/Archived
 * scope switch on the left, a multi-select project filter and a list/grid
 * view toggle on the right.
 */
export function SessionListControls({
  scope,
  onScopeChange,
  archivedCount,
  projects,
  selectedProjectIds,
  onSelectedProjectIdsChange,
  showNoProject = false,
  view,
  onViewChange,
}: SessionListControlsProps) {
  const { t } = useTranslation(["sessions"]);

  const toggleProjectId = (projectId: string) => {
    const next = new Set(selectedProjectIds);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
    }
    onSelectedProjectIdsChange(next);
  };

  const selectedCount = selectedProjectIds.size;
  const singleSelectedId =
    selectedCount === 1 ? [...selectedProjectIds][0] : undefined;
  const singleSelectedProject =
    singleSelectedId !== undefined
      ? projects.find((project) => project.id === singleSelectedId)
      : undefined;

  let filterLabel: string;
  if (selectedCount === 0) {
    filterLabel = t("history.controls.allProjects", {
      defaultValue: "All projects",
    });
  } else if (selectedCount === 1) {
    filterLabel =
      singleSelectedId === NO_PROJECT_FILTER_ID
        ? t("history.controls.noProject", { defaultValue: "No project" })
        : (singleSelectedProject?.name ??
          t("history.controls.projectsSelected", {
            count: 1,
            defaultValue: "{{count}} projects",
          }));
  } else {
    filterLabel = t("history.controls.projectsSelected", {
      count: selectedCount,
      defaultValue: "{{count}} projects",
    });
  }

  const archivedLabel =
    typeof archivedCount === "number"
      ? t("history.controls.archivedWithCount", {
          count: archivedCount,
          defaultValue: "Archived ({{count}})",
        })
      : t("history.controls.archived", { defaultValue: "Archived" });

  return (
    // Wrapping keeps every control reachable at the 608px minimum window
    // width, where long project names or translated labels would otherwise
    // push the view toggle past the page padding.
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs
        value={scope}
        onValueChange={(value) => onScopeChange(value as SessionScope)}
      >
        <TabsList variant="weight">
          <TabsTrigger value="active" variant="weight">
            {t("history.controls.active", { defaultValue: "Active" })}
          </TabsTrigger>
          <TabsTrigger value="archived" variant="weight">
            {archivedLabel}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* The view toggle is a segmented control, so its own items stay joined;
          this gap only separates it from the project filter beside it. */}
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The label is the only elastic part of this row, so it absorbs
                the narrow-width squeeze by truncating. */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<ListFilter />}
              className="min-w-0"
            >
              <span className="truncate">{filterLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* "All projects" clears the filter rather than being a fourth
                selectable value, so it stays a command item. Its check is
                decorative — the empty-selection state is already spoken by the
                unchecked project rows below. */}
            <DropdownMenuItem
              onSelect={() => onSelectedProjectIdsChange(new Set())}
            >
              <span aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">
                {t("history.controls.allProjects", {
                  defaultValue: "All projects",
                })}
              </span>
              <Check
                aria-hidden="true"
                className={cn(
                  "ml-auto size-4 shrink-0",
                  selectedCount > 0 && "opacity-0",
                )}
              />
            </DropdownMenuItem>
            {projects.map((project) => (
              <DropdownMenuCheckboxItem
                key={project.id}
                checked={selectedProjectIds.has(project.id)}
                indicatorSide="end"
                // Toggling must not dismiss the menu: the filter is
                // multi-select, so preventing the default close keeps several
                // projects selectable in one pass.
                onSelect={(event) => {
                  event.preventDefault();
                  toggleProjectId(project.id);
                }}
              >
                <ProjectIcon
                  icon={project.icon}
                  color={project.color}
                  projectId={project.id}
                  className="size-4"
                  imageClassName="size-4 rounded-[3px] object-contain"
                />
                <span className="truncate">{project.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {showNoProject ? (
              <DropdownMenuCheckboxItem
                checked={selectedProjectIds.has(NO_PROJECT_FILTER_ID)}
                indicatorSide="end"
                onSelect={(event) => {
                  event.preventDefault();
                  toggleProjectId(NO_PROJECT_FILTER_ID);
                }}
              >
                <Package
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="truncate">
                  {t("history.controls.noProject", {
                    defaultValue: "No project",
                  })}
                </span>
              </DropdownMenuCheckboxItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* ToggleGroup renders the same on-state fill for whichever view is
            selected, so list and grid read identically when active. */}
        <ToggleGroup
          type="single"
          size="sm"
          className="shrink-0"
          value={view}
          onValueChange={(value) => {
            if (value === "list" || value === "grid") onViewChange(value);
          }}
        >
          <ToggleGroupItem
            value="list"
            aria-label={t("history.controls.listView", {
              defaultValue: "List view",
            })}
          >
            <List />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="grid"
            aria-label={t("history.controls.gridView", {
              defaultValue: "Grid view",
            })}
          >
            <LayoutGrid />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
