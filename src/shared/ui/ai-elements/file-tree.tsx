import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { cn } from "@/shared/lib/cn";
import { FileContextMenu } from "@/shared/ui/file-context-menu";
import {
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
} from "@tabler/icons-react";
import { SIDEBAR_MENU_HOVER_TRANSITION_CLASS } from "@/shared/ui/sidebar-tokens";
import type { HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type FileTreeDensity = "default" | "compact";

interface FileTreeContextType {
  density: FileTreeDensity;
  expandedPaths: Set<string>;
  togglePath: (path: string) => void;
  selectedPath?: string;
  onSelect?: (path: string) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

const FileTreeContext = createContext<FileTreeContextType>({
  density: "default",
  // oxlint-disable-next-line eslint-plugin-unicorn(no-new-builtin)
  expandedPaths: new Set(),
  togglePath: noop,
});

const fileTreeRowClassName = cn(
  "flex w-full items-center gap-3 rounded-sm px-3.5 py-2.5 text-left hover:bg-muted/50",
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
);

const fileTreeButtonClassName = cn(
  "flex min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent p-0 text-left",
  "gap-3",
);

export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  contentClassName?: string;
  density?: FileTreeDensity;
  expanded?: Set<string>;
  defaultExpanded?: Set<string>;
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
};

export const FileTree = ({
  density = "default",
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onExpandedChange,
  contentClassName,
  className,
  children,
  ...props
}: FileTreeProps) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expandedPaths = controlledExpanded ?? internalExpanded;

  const togglePath = useCallback(
    (path: string) => {
      const newExpanded = new Set(expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      setInternalExpanded(newExpanded);
      onExpandedChange?.(newExpanded);
    },
    [expandedPaths, onExpandedChange],
  );

  const contextValue = useMemo(
    () => ({ density, expandedPaths, onSelect, selectedPath, togglePath }),
    [density, expandedPaths, onSelect, selectedPath, togglePath],
  );

  return (
    <FileTreeContext.Provider value={contextValue}>
      <div
        className={cn(
          "rounded-md border border-border bg-background text-sm text-foreground",
          className,
        )}
        role="tree"
        {...props}
      >
        <div className={cn("p-2", contentClassName)}>{children}</div>
      </div>
    </FileTreeContext.Provider>
  );
};

export type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeIcon = ({
  className,
  children,
  ...props
}: FileTreeIconProps) => (
  <span className={cn("shrink-0", className)} {...props}>
    {children}
  </span>
);

export type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeName = ({
  className,
  children,
  ...props
}: FileTreeNameProps) => (
  <span className={cn("truncate", className)} {...props}>
    {children}
  </span>
);

interface FileTreeFolderContextType {
  path: string;
  name: string;
  isExpanded: boolean;
}

const FileTreeFolderContext = createContext<FileTreeFolderContextType>({
  isExpanded: false,
  name: "",
  path: "",
});

export type FileTreeFolderProps = HTMLAttributes<HTMLDivElement> & {
  contextMenuPath?: string;
  path: string;
  name: string;
  rowClassName?: string;
  toggleOnSelect?: boolean;
};

export const FileTreeFolder = ({
  contextMenuPath,
  path,
  name,
  rowClassName,
  toggleOnSelect = false,
  className,
  children,
  ...props
}: FileTreeFolderProps) => {
  const { density, expandedPaths, togglePath, selectedPath, onSelect } =
    useContext(FileTreeContext);
  const isExpanded = expandedPaths.has(path);
  const isSelected = selectedPath === path;

  const handleOpenChange = useCallback(() => {
    togglePath(path);
  }, [togglePath, path]);

  const handleSelect = useCallback(() => {
    if (toggleOnSelect) {
      togglePath(path);
      return;
    }
    onSelect?.(path);
  }, [onSelect, path, toggleOnSelect, togglePath]);

  const folderContextValue = useMemo(
    () => ({ isExpanded, name, path }),
    [isExpanded, name, path],
  );

  return (
    <FileTreeFolderContext.Provider value={folderContextValue}>
      <Collapsible onOpenChange={handleOpenChange} open={isExpanded}>
        <div
          className={cn("", className)}
          role="treeitem"
          tabIndex={0}
          {...props}
        >
          {contextMenuPath ? (
            <FileContextMenu path={contextMenuPath}>
              <div
                className={cn(
                  fileTreeRowClassName,
                  rowClassName,
                  isSelected && "bg-muted",
                )}
              >
                <CollapsibleTrigger asChild>
                  <button
                    className="flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0"
                    type="button"
                  >
                    <IconChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90",
                      )}
                    />
                  </button>
                </CollapsibleTrigger>
                <button
                  className={fileTreeButtonClassName}
                  onClick={handleSelect}
                  type="button"
                >
                  <FileTreeIcon>
                    {isExpanded ? (
                      <IconFolderOpen className="size-4 text-muted-foreground" />
                    ) : (
                      <IconFolder className="size-4 text-muted-foreground" />
                    )}
                  </FileTreeIcon>
                  <FileTreeName>{name}</FileTreeName>
                </button>
              </div>
            </FileContextMenu>
          ) : (
            <div
              className={cn(
                fileTreeRowClassName,
                rowClassName,
                isSelected && "bg-muted",
              )}
            >
              <CollapsibleTrigger asChild>
                <button
                  className="flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0"
                  type="button"
                >
                  <IconChevronRight
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <button
                className={fileTreeButtonClassName}
                onClick={handleSelect}
                type="button"
              >
                <FileTreeIcon>
                  {isExpanded ? (
                    <IconFolderOpen className="size-4 text-muted-foreground" />
                  ) : (
                    <IconFolder className="size-4 text-muted-foreground" />
                  )}
                </FileTreeIcon>
                <FileTreeName>{name}</FileTreeName>
              </button>
            </div>
          )}
          <CollapsibleContent>
            <div
              className={cn(
                "border-l",
                density === "compact" ? "ml-2 pl-1" : "ml-4 pl-2",
              )}
            >
              {children}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </FileTreeFolderContext.Provider>
  );
};

interface FileTreeFileContextType {
  path: string;
  name: string;
}

const FileTreeFileContext = createContext<FileTreeFileContextType>({
  name: "",
  path: "",
});

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
  contextMenuPath?: string;
  path: string;
  name: string;
  icon?: ReactNode;
};

export const FileTreeFile = ({
  contextMenuPath,
  path,
  name,
  icon,
  className,
  children,
  ...props
}: FileTreeFileProps) => {
  const { selectedPath, onSelect } = useContext(FileTreeContext);
  const isSelected = selectedPath === path;

  const handleClick = useCallback(() => {
    onSelect?.(path);
  }, [onSelect, path]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        onSelect?.(path);
      }
    },
    [onSelect, path],
  );

  const fileContextValue = useMemo(() => ({ name, path }), [name, path]);

  return (
    <FileTreeFileContext.Provider value={fileContextValue}>
      {contextMenuPath ? (
        <FileContextMenu path={contextMenuPath}>
          <div
            className={cn(
              fileTreeRowClassName,
              "cursor-pointer",
              isSelected && "bg-muted",
              className,
            )}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="treeitem"
            tabIndex={0}
            {...props}
          >
            {children ?? (
              <>
                {/* Spacer for alignment */}
                <span className="size-4 shrink-0" />
                <FileTreeIcon>
                  {icon ?? (
                    <IconFile className="size-4 text-muted-foreground" />
                  )}
                </FileTreeIcon>
                <FileTreeName>{name}</FileTreeName>
              </>
            )}
          </div>
        </FileContextMenu>
      ) : (
        <div
          className={cn(
            fileTreeRowClassName,
            "cursor-pointer",
            isSelected && "bg-muted",
            className,
          )}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          role="treeitem"
          tabIndex={0}
          {...props}
        >
          {children ?? (
            <>
              {/* Spacer for alignment */}
              <span className="size-4 shrink-0" />
              <FileTreeIcon>
                {icon ?? <IconFile className="size-4 text-muted-foreground" />}
              </FileTreeIcon>
              <FileTreeName>{name}</FileTreeName>
            </>
          )}
        </div>
      )}
    </FileTreeFileContext.Provider>
  );
};

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>;

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

export const FileTreeActions = ({
  className,
  children,
  ...props
}: FileTreeActionsProps) => (
  <div
    className={cn("ml-auto flex items-center gap-1", className)}
    onClick={stopPropagation}
    onKeyDown={stopPropagation}
    role="group"
    {...props}
  >
    {children}
  </div>
);
