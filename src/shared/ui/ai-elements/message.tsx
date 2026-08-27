import { Button } from "@/shared/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/shared/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/tooltip";
import { parseSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";
import { isExternalHref } from "@/shared/lib/isExternalHref";
import { isUrlTrusted } from "@/shared/lib/trustedDomains";
import { LinkSafetyModal } from "@/shared/ui/ai-elements/link-safety-modal";
import { cn } from "@/shared/lib/cn";
import { useVirtualLayoutPendingForStreamdown } from "@/features/chat/transcript/measurement";
import { useStreamdownTableScrollbarSizing } from "@/shared/ui/ai-elements/streamdown-table-scrollbar";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import type {
  ComponentType,
  ComponentProps,
  HTMLAttributes,
  MouseEvent,
  ReactElement,
} from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Components as StreamdownComponents,
  type CustomRenderer,
  defaultRehypePlugins,
  Streamdown,
} from "streamdown";
import { useTranslation } from "react-i18next";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-sm group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null,
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch",
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { t } = useTranslation("common");
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label={t("components.messageBranch.previous")}
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { t } = useTranslation("common");
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label={t("components.messageBranch.next")}
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { t } = useTranslation("common");
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className,
      )}
      {...props}
    >
      {t("components.messageBranch.page", {
        current: currentBranch + 1,
        total: totalBranches,
      })}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  codeRenderers?: CustomRenderer[];
  /** Source-text offset after which rendered Markdown is struck through. */
  strikethroughFrom?: number;
  /** Accessible label announced before visually struck voice-undelivered text. */
  strikethroughLabel?: string;
  /**
   * Optional feature-aware Markdown image renderer. Chat injects one that can
   * resolve local files through the asset scheme; when omitted, images render
   * with a plain <img>. Keeps this shared module free of chat-feature imports.
   */
  imageRenderer?: MarkdownImageRenderer;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export type MermaidDownloadFormat = "svg" | "png" | "mmd";

export function detectStreamdownMermaidDownloadFormat(
  target: EventTarget | null,
): MermaidDownloadFormat | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const button = target.closest("button");
  if (!button?.closest('[data-streamdown="mermaid-block-actions"]')) {
    return null;
  }

  const label =
    `${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`
      .trim()
      .toLowerCase();

  if (/\bsvg\b/.test(label)) return "svg";
  if (/\bpng\b/.test(label)) return "png";
  if (/\bmmd\b/.test(label)) return "mmd";

  return null;
}

async function openDownloadsFolder() {
  const [{ downloadDir }, { openPath }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-opener"),
  ]);
  await openPath(await downloadDir());
}

type OpenLinkSafetyModal = (url: string) => void;

const LinkSafetyContext = createContext<OpenLinkSafetyModal | null>(null);

/**
 * Custom link component that splits behavior by link type:
 * - External links → <a> with preventDefault that opens a LinkSafetyModal via context
 * - Internal links → plain <a> so useArtifactLinkHandler can intercept via closest("a")
 *
 * Both render as <a> elements. useArtifactLinkHandler has an early return for external
 * hrefs, so there is no conflict with its delegated click handler.
 *
 * This replaces Streamdown's built-in linkSafety which renders <button> for ALL
 * links, breaking artifact navigation since useArtifactLinkHandler matches on <a>.
 */
const MarkdownLink = memo(
  ({
    children,
    href,
    node: _node,
    ...rest
  }: ComponentProps<"a"> & { node?: unknown }) => {
    const openModal = useContext(LinkSafetyContext);

    if (isExternalHref(href)) {
      return (
        <a
          className="wrap-anywhere font-medium text-primary underline"
          data-streamdown="link"
          href={href}
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            if (isUrlTrusted(href ?? "")) {
              void import("@tauri-apps/plugin-opener")
                .then(({ openUrl }) => openUrl(href ?? ""))
                .catch((error: unknown) => {
                  console.error("[linkSafety] openUrl failed:", error);
                });
            } else {
              openModal?.(href ?? "");
            }
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    if (parseSessionDeepLink(href ?? "")) {
      return (
        <a
          className="wrap-anywhere font-medium text-primary underline"
          data-streamdown="link"
          href={href}
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void import("@/features/sessions/lib/openSessionDeepLink")
              .then(({ openSessionDeepLink }) =>
                openSessionDeepLink(href ?? ""),
              )
              .catch((error: unknown) => {
                console.error("[sessionDeepLink] open failed:", error);
              });
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    if (isReservedBerdSessionLinkPrefix(href)) {
      return (
        <>
          {children}
          {/* i18n-check-ignore — mirrors Streamdown's sanitizer marker for blocked links */}
          {" [blocked]"}
        </>
      );
    }

    return (
      <a
        className="wrap-anywhere font-medium text-primary underline"
        data-streamdown="link"
        href={href}
        rel="noreferrer"
        {...rest}
      >
        {children}
      </a>
    );
  },
);
MarkdownLink.displayName = "MarkdownLink";

export type MarkdownImageRenderer = NonNullable<StreamdownComponents["img"]>;

// Default Markdown image renderer: plain <img>. Chat injects a feature-aware
// renderer (local file → asset: scheme) via the `imageRenderer` prop on
// MessageResponse so this shared module stays free of chat-feature dependencies.
const DefaultMarkdownImage: MarkdownImageRenderer = ({
  node: _node,
  ...rest
}) => <img {...rest} alt={rest.alt ?? ""} />;

/**
 * Markdown heading scale.
 *
 * Streamdown ships a web-document scale (h1 `text-3xl`, h2 `text-2xl`,
 * h3 `text-xl`) that overshoots the app hierarchy in DESIGN.md §3, where Title
 * tops out at `text-lg` and body copy is `text-sm`. Rendered inside product
 * chrome — the doc viewer, agent/skill detail pages, chat — those headings read
 * like a marketing page instead of app UI, and an `# H1` in a file ends up
 * larger than any real page title in the window.
 *
 * Overriding through `components` rather than CSS matters: it replaces the
 * class on the element instead of merely out-specifying it, so the DOM carries
 * the app scale and `cn()` still lets a surface adjust a heading locally.
 *
 * Per The Calm Scale Rule, hierarchy comes from weight and rhythm rather than
 * size. Sizes compress into `text-lg` → `text-sm`, and separation is carried by
 * the space above each heading. h4–h6 have no size headroom left above body
 * copy, so they separate by weight and color; h6 settles into a quiet label.
 *
 * No `uppercase` anywhere in this scale, even though DESIGN.md's Label style
 * uses it: heading text here is authored document content, not app chrome.
 * Transforming it would rewrite the author's casing and corrupt identifiers
 * (`api_KEY` → `API_KEY`), filenames, and paths that appear in headings.
 */
const MARKDOWN_HEADING_CLASS = {
  1: "mt-6 mb-2 font-display text-lg font-semibold leading-6 tracking-tight",
  2: "mt-6 mb-2 font-display text-base font-semibold leading-6 tracking-tight",
  3: "mt-5 mb-1.5 font-display text-sm font-semibold leading-5 tracking-tight",
  4: "mt-4 mb-1 text-sm font-semibold leading-5",
  5: "mt-4 mb-1 text-sm font-medium leading-5",
  6: "mt-4 mb-1 text-xs font-medium tracking-wide text-muted-foreground",
} as const;

type MarkdownHeadingLevel = keyof typeof MARKDOWN_HEADING_CLASS;

function createMarkdownHeading(level: MarkdownHeadingLevel) {
  const Tag = `h${level}` as const;
  const headingClass = MARKDOWN_HEADING_CLASS[level];

  const MarkdownHeading = ({
    className,
    node: _node,
    ...rest
  }: ComponentProps<typeof Tag> & { node?: unknown }) => (
    <Tag className={cn(headingClass, className)} {...rest} />
  );
  MarkdownHeading.displayName = `MarkdownHeading${level}`;
  return MarkdownHeading;
}

const markdownHeadingComponents = {
  h1: createMarkdownHeading(1),
  h2: createMarkdownHeading(2),
  h3: createMarkdownHeading(3),
  h4: createMarkdownHeading(4),
  h5: createMarkdownHeading(5),
  h6: createMarkdownHeading(6),
} satisfies Pick<StreamdownComponents, "h1" | "h2" | "h3" | "h4" | "h5" | "h6">;

function buildStreamdownComponents(
  imageRenderer?: MarkdownImageRenderer,
  unspokenLabel?: string,
) {
  const ImageRenderer = (imageRenderer ??
    DefaultMarkdownImage) as unknown as ComponentType<
    ComponentProps<"img"> & { node?: unknown }
  >;
  const VoiceAwareImage: MarkdownImageRenderer = (props) => {
    const marksBoundary = props.className
      ?.split(/\s+/)
      .includes("voice-unspoken-boundary");
    const image = (
      <ImageRenderer
        {...props}
        alt={
          marksBoundary && unspokenLabel && props.alt
            ? `${unspokenLabel}: ${props.alt ?? ""}`
            : props.alt
        }
      />
    );
    return marksBoundary && unspokenLabel && !props.alt ? (
      <>
        <span className="sr-only">{unspokenLabel}: </span>
        {image}
      </>
    ) : (
      image
    );
  };
  return {
    ...markdownHeadingComponents,
    a: MarkdownLink,
    img: VoiceAwareImage,
  };
}

/**
 * `rehype-harden` treats only `/`, `./`, and `../` as relative URLs. Bare
 * filesystem paths such as `wiki/report.md` are therefore replaced with a
 * `[blocked]` indicator before Berd's artifact click handler can resolve them
 * against the session working directory. It also blocks Berd's custom deep-link
 * scheme. Prefix only bare path-like destinations and parseable Berd session
 * links for the sanitizer, then remove the prefixes afterwards so the renderer
 * and click-routing policy receive the original href. Other custom schemes and
 * malformed `berd:` links remain blocked.
 */
const BERD_LOCAL_PATH_PREFIX = "/__berd_local_path__/";
const BERD_SESSION_LINK_PREFIX_ROOT = "/__berd_session_link__/";
const BERD_SESSION_LINK_PREFIX = `${BERD_SESSION_LINK_PREFIX_ROOT}${createBerdSessionLinkNonce()}/`;
const MARKDOWN_DESTINATION_PROPERTY = new Set(["href", "src"]);

function createBerdSessionLinkNonce(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isReservedBerdSessionLinkPrefix(href: string | undefined): boolean {
  return href?.startsWith(BERD_SESSION_LINK_PREFIX_ROOT) ?? false;
}

type MarkdownHastNode = {
  children?: MarkdownHastNode[];
  properties?: Record<string, unknown>;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  tagName?: string;
  type?: string;
  value?: string;
};

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isBareLocalMarkdownPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("#") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("./") &&
    !trimmed.startsWith("../") &&
    !hasControlCharacter(trimmed) &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  );
}

function isValidBerdSessionDeepLink(value: string): boolean {
  return parseSessionDeepLink(value) !== null;
}

function visitMarkdownDestinations(
  node: MarkdownHastNode,
  transform: (value: string, property: string) => string,
) {
  if (node.properties) {
    for (const property of MARKDOWN_DESTINATION_PROPERTY) {
      const value = node.properties[property];
      if (typeof value === "string") {
        node.properties[property] = transform(value, property);
      }
    }
  }
  for (const child of node.children ?? []) {
    visitMarkdownDestinations(child, transform);
  }
}

function prefixBerdMarkdownDestinations() {
  return (tree: MarkdownHastNode) => {
    visitMarkdownDestinations(tree, (value, property) => {
      if (isBareLocalMarkdownPath(value)) {
        return `${BERD_LOCAL_PATH_PREFIX}${encodeURIComponent(value)}`;
      }
      if (property === "href" && isValidBerdSessionDeepLink(value)) {
        return `${BERD_SESSION_LINK_PREFIX}${encodeURIComponent(value)}`;
      }
      return value;
    });
  };
}

function restoreBerdMarkdownDestinations() {
  return (tree: MarkdownHastNode) => {
    visitMarkdownDestinations(tree, (value, property) => {
      if (value.startsWith(BERD_LOCAL_PATH_PREFIX)) {
        const encodedPath = value.slice(BERD_LOCAL_PATH_PREFIX.length);
        try {
          const decodedPath = decodeURIComponent(encodedPath);
          return isBareLocalMarkdownPath(decodedPath) ? decodedPath : value;
        } catch {
          return value;
        }
      }

      if (property === "href" && value.startsWith(BERD_SESSION_LINK_PREFIX)) {
        const encodedHref = value.slice(BERD_SESSION_LINK_PREFIX.length);
        try {
          const decodedHref = decodeURIComponent(encodedHref);
          return isValidBerdSessionDeepLink(decodedHref) ? decodedHref : value;
        } catch {
          return value;
        }
      }

      return value;
    });
  };
}

const berdRehypePlugins: NonNullable<
  ComponentProps<typeof Streamdown>["rehypePlugins"]
> = [
  defaultRehypePlugins.raw,
  prefixBerdMarkdownDestinations,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
  restoreBerdMarkdownDestinations,
];

const decodedEntityCache = new Map<string, string | null>();

function decodeHtmlEntity(entity: string): string | null {
  const cached = decodedEntityCache.get(entity);
  if (cached !== undefined) return cached;
  if (
    typeof document === "undefined" ||
    !/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);$/i.test(entity)
  ) {
    return null;
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = entity;
  const decoded = textarea.value === entity ? null : textarea.value;
  decodedEntityCache.set(entity, decoded);
  return decoded;
}

function renderedPrefixLength(source: string, rendered: string): number {
  let sourceOffset = 0;
  let renderedOffset = 0;
  while (sourceOffset < source.length && renderedOffset < rendered.length) {
    if (
      source[sourceOffset] === "\\" &&
      sourceOffset + 1 < source.length &&
      source[sourceOffset + 1] === rendered[renderedOffset]
    ) {
      sourceOffset += 2;
      renderedOffset += 1;
      continue;
    }
    if (source[sourceOffset] === "&") {
      const semicolon = source.indexOf(";", sourceOffset + 1);
      if (semicolon !== -1) {
        const decoded = decodeHtmlEntity(
          source.slice(sourceOffset, semicolon + 1),
        );
        if (decoded && rendered.startsWith(decoded, renderedOffset)) {
          sourceOffset = semicolon + 1;
          renderedOffset += decoded.length;
          continue;
        }
      }
    }
    if (source[sourceOffset] !== rendered[renderedOffset]) break;
    sourceOffset += 1;
    renderedOffset += 1;
  }
  return renderedOffset;
}

function strikethroughFromPlugin(
  cutoff: number,
  label: string,
  source: string,
) {
  const structureElements = new Set([
    "dl",
    "menu",
    "ol",
    "p",
    "select",
    "table",
    "tbody",
    "tfoot",
    "thead",
    "tr",
    "ul",
  ]);
  const voidElements = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const accessibleLabel = (): MarkdownHastNode => ({
    type: "element",
    tagName: "span",
    properties: { className: ["sr-only"] },
    children: [{ type: "text", value: `${label}: ` }],
  });
  let boundaryAnnounced = false;
  const boundaryLabel = (): MarkdownHastNode[] => {
    if (boundaryAnnounced) return [];
    boundaryAnnounced = true;
    return [accessibleLabel()];
  };
  const wrap = (node: MarkdownHastNode): MarkdownHastNode => ({
    type: "element",
    tagName: "span",
    properties: {
      className: ["line-through"],
      "data-voice-unspoken": "true",
    },
    children: [node],
    position: node.position,
  });

  const decorate = (node: MarkdownHastNode) => {
    if (!node.children) return;
    const children: MarkdownHastNode[] = [];
    for (const child of node.children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (
        child.type === "element" &&
        start !== undefined &&
        end !== undefined &&
        (cutoff <= start ||
          (voidElements.has(child.tagName ?? "") && cutoff < end)) &&
        !structureElements.has(child.tagName ?? "")
      ) {
        if (voidElements.has(child.tagName ?? "")) {
          const className = child.properties?.className;
          const marksBoundary =
            child.tagName === "img" &&
            (cutoff > start || !source.slice(cutoff, start).trim());
          if (marksBoundary) boundaryAnnounced = true;
          child.properties = {
            ...child.properties,
            className: [
              ...(Array.isArray(className)
                ? className
                : typeof className === "string"
                  ? [className]
                  : []),
              "line-through",
              ...(marksBoundary ? ["voice-unspoken-boundary"] : []),
            ],
            "data-voice-unspoken": "true",
          };
          children.push(child);
          continue;
        }
        if (child.tagName === "pre") {
          children.push(...boundaryLabel());
          children.push({
            type: "element",
            tagName: "div",
            properties: {
              className: ["line-through"],
              "data-voice-unspoken": "true",
            },
            children: [child],
            position: child.position,
          });
          continue;
        }
        const className = child.properties?.className;
        child.properties = {
          ...child.properties,
          className: [
            ...(Array.isArray(className)
              ? className
              : typeof className === "string"
                ? [className]
                : []),
            "line-through",
          ],
          "data-voice-unspoken": "true",
        };
        if (child.children) {
          child.children = [...boundaryLabel(), ...child.children];
        } else {
          children.push(...boundaryLabel());
        }
        children.push(child);
        continue;
      }
      if (
        child.type === "text" &&
        child.value !== undefined &&
        start !== undefined &&
        end !== undefined
      ) {
        if (!child.value.trim()) {
          children.push(child);
          continue;
        }
        if (cutoff <= start) {
          children.push(...boundaryLabel());
          children.push(wrap(child));
          continue;
        }
        if (cutoff < end) {
          const valueOffset = renderedPrefixLength(
            source.slice(start, cutoff),
            child.value,
          );
          const spoken = child.value.slice(0, valueOffset);
          const unspoken = child.value.slice(valueOffset);
          if (spoken) children.push({ ...child, value: spoken });
          if (unspoken) {
            children.push(...boundaryLabel());
            children.push(wrap({ ...child, value: unspoken }));
          }
          continue;
        }
      }
      decorate(child);
      children.push(child);
    }
    node.children = children;
  };

  return (tree: MarkdownHastNode) => decorate(tree);
}

const linkSafetyConfig: ComponentProps<typeof Streamdown>["linkSafety"] = {
  enabled: false,
};

export const MessageResponse = memo(
  ({
    children,
    className,
    codeRenderers,
    imageRenderer,
    isAnimating,
    mode,
    onAnimationEnd,
    onAnimationStart,
    strikethroughFrom,
    strikethroughLabel = "Not spoken",
    ...props
  }: MessageResponseProps) => {
    const { t } = useTranslation("common");
    const [modalUrl, setModalUrl] = useState<string | null>(null);
    const streamdownComponents = useMemo(
      () => buildStreamdownComponents(imageRenderer, strikethroughLabel),
      [imageRenderer, strikethroughLabel],
    );
    const rehypePlugins = useMemo<
      NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>
    >(
      () =>
        strikethroughFrom === undefined
          ? berdRehypePlugins
          : [
              ...berdRehypePlugins,
              [
                strikethroughFromPlugin,
                strikethroughFrom,
                strikethroughLabel,
                children,
              ],
            ],
      [children, strikethroughFrom, strikethroughLabel],
    );
    const streamdownRootRef = useRef<HTMLDivElement>(null);
    const streamdownLayoutPending = useVirtualLayoutPendingForStreamdown({
      contentKey: children,
      isAnimating,
      mode,
      onAnimationEnd,
      onAnimationStart,
    });
    useStreamdownTableScrollbarSizing(streamdownRootRef, children);

    const openModal = useCallback((url: string) => {
      setModalUrl(url);
    }, []);

    const closeModal = useCallback(() => {
      setModalUrl(null);
    }, []);

    const handleClickCapture = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        const format = detectStreamdownMermaidDownloadFormat(event.target);
        if (!format) {
          return;
        }

        const filename = `diagram.${format}`;
        const options = window.__TAURI_INTERNALS__
          ? {
              action: {
                label: t("components.mermaid.openDownloads"),
                onClick: () => {
                  void openDownloadsFolder().catch((error) => {
                    console.error("Failed to open Downloads folder:", error);
                    toast.error(t("components.mermaid.openDownloadsError"));
                  });
                },
              },
            }
          : {};

        toast.message(
          t("components.mermaid.downloadStarted", { filename }),
          options,
        );
      },
      [t],
    );

    return (
      <LinkSafetyContext.Provider value={openModal}>
        <div
          className="contents"
          onClickCapture={handleClickCapture}
          ref={streamdownRootRef}
          {...streamdownLayoutPending.layoutPendingAttributes}
        >
          <Streamdown
            key={
              strikethroughFrom === undefined
                ? "normal"
                : `${strikethroughFrom}:${strikethroughLabel}`
            }
            className={cn(
              "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              className,
            )}
            components={streamdownComponents}
            isAnimating={isAnimating}
            linkSafety={linkSafetyConfig}
            mode={strikethroughFrom === undefined ? mode : "static"}
            onAnimationEnd={streamdownLayoutPending.onAnimationEnd}
            onAnimationStart={streamdownLayoutPending.onAnimationStart}
            rehypePlugins={rehypePlugins}
            plugins={
              codeRenderers
                ? { ...streamdownPlugins, renderers: codeRenderers }
                : streamdownPlugins
            }
            {...props}
          >
            {children}
          </Streamdown>
        </div>
        <LinkSafetyModal
          isOpen={modalUrl !== null}
          onClose={closeModal}
          url={modalUrl ?? ""}
        />
      </LinkSafetyContext.Provider>
    );
  },
  // Internal state (modalUrl) is intentionally outside this comparator —
  // React always re-renders when local state changes regardless of memo.
  // If modalUrl is ever lifted to a prop, this comparator must be updated.
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating &&
    nextProps.mode === prevProps.mode &&
    nextProps.strikethroughFrom === prevProps.strikethroughFrom &&
    nextProps.strikethroughLabel === prevProps.strikethroughLabel &&
    nextProps.codeRenderers === prevProps.codeRenderers,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
