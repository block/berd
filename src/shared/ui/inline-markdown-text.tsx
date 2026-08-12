import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";

const inlineComponents = {
  a: ({ children }) => (
    <span className="font-medium underline decoration-current/30">
      {children}
    </span>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 text-[0.95em]">
      {children}
    </code>
  ),
  del: ({ children }) => <del>{children}</del>,
  em: ({ children }) => <em>{children}</em>,
  strong: ({ children }) => (
    <strong className="font-medium text-current">{children}</strong>
  ),
} satisfies Components;

const allowedInlineElements = ["a", "br", "code", "del", "em", "strong"];

type InlineMarkdownTextProps = Omit<ComponentProps<"span">, "children"> & {
  children: string;
};

export function InlineMarkdownText({
  children,
  className,
  ...props
}: InlineMarkdownTextProps) {
  return (
    <span className={cn("min-w-0", className)} {...props}>
      <ReactMarkdown
        allowedElements={allowedInlineElements}
        components={inlineComponents}
        remarkPlugins={[remarkGfm]}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </span>
  );
}
