import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Component,
  Crosshair,
  Palette,
  X,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";
import {
  collectDesignSystemInspection,
  getElementRect,
  type DesignSystemInspection,
} from "./designSystemInspection";

type InspectionRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export function DesignSystemInspector() {
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState<DesignSystemInspection | null>(null);
  const [selected, setSelected] = useState<DesignSystemInspection | null>(null);
  const [hoverRect, setHoverRect] = useState<InspectionRect | null>(null);
  const [selectedRect, setSelectedRect] = useState<InspectionRect | null>(null);

  const visibleInspection = selected ?? hovered;
  const outlineRect = selectedRect ?? hoverRect;

  const refreshRects = useCallback(() => {
    setHoverRect(getElementRect(hovered?.element ?? null));
    setSelectedRect(getElementRect(selected?.element ?? null));
  }, [hovered, selected]);

  useEffect(() => {
    if (!active) {
      setHovered(null);
      setHoverRect(null);
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const nextInspection = collectDesignSystemInspection(event.target);
      setHovered(nextInspection);
      setHoverRect(getElementRect(nextInspection?.element ?? null));
    };

    const handleClick = (event: MouseEvent) => {
      const nextInspection = collectDesignSystemInspection(event.target);
      if (!nextInspection) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(nextInspection);
      setSelectedRect(getElementRect(nextInspection.element));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selected) {
          setSelected(null);
          setSelectedRect(null);
          return;
        }
        setActive(false);
      }
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("click", handleClick, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", refreshRects, true);
    window.addEventListener("resize", refreshRects);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("click", handleClick, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", refreshRects, true);
      window.removeEventListener("resize", refreshRects);
    };
  }, [active, refreshRects, selected]);

  const toggleLabel = active ? "Inspecting" : "Inspect";

  return (
    <div data-design-system-inspector="root">
      {outlineRect ? (
        <InspectorOutline rect={outlineRect} locked={Boolean(selected)} />
      ) : null}

      <div className="fixed right-4 bottom-4 z-[120] flex items-center gap-2">
        {selected ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leftIcon={<X aria-hidden="true" />}
            onClick={() => {
              setSelected(null);
              setSelectedRect(null);
            }}
          >
            Clear
          </Button>
        ) : null}
        <Button
          type="button"
          variant={active ? "default" : "secondary"}
          size="sm"
          leftIcon={<Crosshair aria-hidden="true" />}
          onClick={() => setActive((current) => !current)}
          aria-pressed={active}
        >
          {toggleLabel}
        </Button>
      </div>

      {active && visibleInspection ? (
        <InspectorPanel
          inspection={visibleInspection}
          locked={Boolean(selected)}
          onClose={() => {
            setSelected(null);
            setActive(false);
          }}
        />
      ) : null}
    </div>
  );
}

function InspectorOutline({
  rect,
  locked,
}: {
  rect: InspectionRect;
  locked: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[110] rounded-sm border border-border-focus bg-background-info/10 shadow-mini"
      style={{
        top: rect.top - 2,
        left: rect.left - 2,
        width: rect.width + 4,
        height: rect.height + 4,
        outline: locked
          ? "2px solid var(--border-primary)"
          : "1px solid transparent",
      }}
    />
  );
}

function InspectorPanel({
  inspection,
  locked,
  onClose,
}: {
  inspection: DesignSystemInspection;
  locked: boolean;
  onClose: () => void;
}) {
  const propEntries = Object.entries(inspection.props);
  const classPreview = useMemo(
    () => inspection.classNames.slice(0, 18),
    [inspection.classNames],
  );

  return (
    <aside className="fixed top-16 right-4 bottom-16 z-[120] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-overlay border border-border bg-background-popover text-text-on-popover shadow-popover">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Component
              className="size-4 text-text-primary"
              aria-hidden="true"
            />
            <h2 className="truncate text-sm font-medium">{inspection.label}</h2>
            {locked ? <Badge variant="secondary">locked</Badge> : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {inspection.source ?? `${inspection.tagName} element`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <InspectorSection icon={<Component />} title="Component">
          <DefinitionList
            rows={[
              ["component", inspection.component ?? "Unknown"],
              ["slot", inspection.slot ?? "none"],
              ["tag", inspection.tagName],
              ["variant", inspection.variant ?? "default"],
              ["size", inspection.size ?? "default"],
            ]}
          />
          {propEntries.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {propEntries.map(([key, value]) => (
                <Badge key={key} variant="outline">
                  {key}: {String(value)}
                </Badge>
              ))}
            </div>
          ) : null}
        </InspectorSection>

        <Separator className="my-3" />

        <InspectorSection icon={<Palette />} title="Styling">
          <FindingList findings={inspection.findings} />
          {inspection.semanticClasses.length ? (
            <TokenClassList values={inspection.semanticClasses.slice(0, 16)} />
          ) : null}
        </InspectorSection>

        <Separator className="my-3" />

        <InspectorSection icon={<Code2 />} title="Rendered Element">
          <DefinitionList
            rows={[
              ["role", inspection.role ?? "none"],
              ["aria-label", inspection.ariaLabel ?? "none"],
              ["text", inspection.textSnippet ?? "none"],
            ]}
          />
          {classPreview.length ? (
            <div className="mt-3 rounded-md border border-border bg-background px-2 py-2">
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                class list
              </p>
              <div className="flex flex-wrap gap-1">
                {classPreview.map((className) => (
                  <span
                    key={className}
                    className="rounded-sm bg-background-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {className}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </InspectorSection>

        <Separator className="my-3" />

        <InspectorSection icon={<Palette />} title="Computed">
          <DefinitionList
            rows={inspection.computed.map((item) => [item.label, item.value])}
          />
        </InspectorSection>
      </div>
    </aside>
  );
}

function InspectorSection({
  icon,
  title,
  children,
}: {
  icon: ReactElement;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function DefinitionList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid gap-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-[11px] text-foreground">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FindingList({
  findings,
}: {
  findings: DesignSystemInspection["findings"];
}) {
  return (
    <div className="grid gap-2">
      {findings.map((finding) => {
        const Icon = finding.tone === "warning" ? AlertTriangle : CheckCircle2;
        return (
          <div
            key={finding.text}
            className="flex gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-xs"
          >
            <Icon
              className={
                finding.tone === "warning"
                  ? "mt-0.5 size-3.5 shrink-0 text-text-warning"
                  : "mt-0.5 size-3.5 shrink-0 text-text-success"
              }
              aria-hidden="true"
            />
            <p className="min-w-0 break-words text-foreground">
              {finding.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function TokenClassList({ values }: { values: string[] }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">
        token-like classes
      </p>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="secondary">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}
