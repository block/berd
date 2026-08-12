import { Fragment, memo, useCallback, useMemo } from "react";
import { linkifyText } from "@/shared/lib/linkify";
import { cn } from "@/shared/lib/cn";

export interface LinkifiedTextProps {
  /** Raw text that may contain bare http(s) URLs. */
  text: string;
  /**
   * Render only this prefix while still parsing URLs against the full text.
   * A URL crossing the boundary is emitted as plain text rather than as a
   * clickable link with a truncated destination.
   */
  endOffset?: number;
  className?: string;
}

/**
 * Renders plain text while turning bare http(s) URLs into real links.
 *
 * Intended for user-authored text (e.g. chat messages the user typed or
 * pasted). Because the user is the source of these URLs, links open directly
 * without the LinkSafetyModal confirmation — that guard is reserved for
 * agent-generated Markdown links, where the URL may be untrusted.
 */
export const LinkifiedText = memo(function LinkifiedText({
  text,
  endOffset = text.length,
  className,
}: LinkifiedTextProps) {
  const segments = useMemo(() => {
    const visibleSegments = [];
    let consumed = 0;

    for (const segment of linkifyText(text)) {
      if (consumed >= endOffset) break;
      const visibleLength = Math.min(
        segment.value.length,
        endOffset - consumed,
      );
      if (visibleLength <= 0) break;
      const value = segment.value.slice(0, visibleLength);
      visibleSegments.push(
        segment.type === "link" && visibleLength === segment.value.length
          ? { ...segment, value }
          : { type: "text" as const, value },
      );
      consumed += segment.value.length;
    }

    return visibleSegments;
  }, [endOffset, text]);

  const handleLinkClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      event.preventDefault();
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(href))
        .catch((error: unknown) => {
          console.error("[linkifiedText] openUrl failed:", error);
        });
    },
    [],
  );

  return (
    <p className={cn("whitespace-pre-wrap wrap-anywhere", className)}>
      {segments.map((segment, index) => {
        if (segment.type === "link") {
          return (
            <a
              key={`link-${index}`}
              className="wrap-anywhere font-medium text-primary underline"
              href={segment.href}
              rel="noreferrer"
              onClick={(event) => handleLinkClick(event, segment.href)}
            >
              {segment.value}
            </a>
          );
        }
        return <Fragment key={`text-${index}`}>{segment.value}</Fragment>;
      })}
    </p>
  );
});
