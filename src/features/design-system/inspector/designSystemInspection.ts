export type DesignSystemInspection = {
  element: HTMLElement;
  tagName: string;
  label: string;
  component: string | null;
  slot: string | null;
  source: string | null;
  variant: string | null;
  size: string | null;
  props: Record<string, string | number | boolean>;
  customClassName: string | null;
  classNames: string[];
  semanticClasses: string[];
  styleAttribute: string | null;
  textSnippet: string | null;
  role: string | null;
  ariaLabel: string | null;
  computed: Array<{ label: string; value: string }>;
  findings: Array<{ tone: "info" | "warning"; text: string }>;
};

const INSPECTABLE_SELECTOR = "[data-ds-component], [data-slot]";
const INSPECTOR_SELECTOR = "[data-design-system-inspector]";

const sourceByComponent: Record<string, string> = {
  Alert: "src/shared/ui/alert.tsx",
  Badge: "src/shared/ui/badge.tsx",
  Button: "src/shared/ui/button.tsx",
  ButtonGroup: "src/shared/ui/button-group.tsx",
  Card: "src/shared/ui/card.tsx",
  Checkbox: "src/shared/ui/checkbox.tsx",
  DropdownMenu: "src/shared/ui/dropdown-menu.tsx",
  Input: "src/shared/ui/input.tsx",
  Select: "src/shared/ui/select.tsx",
  Sidebar: "src/shared/ui/sidebar.tsx",
  Switch: "src/shared/ui/switch.tsx",
  Tabs: "src/shared/ui/tabs.tsx",
  Textarea: "src/shared/ui/textarea.tsx",
  Toggle: "src/shared/ui/toggle.tsx",
};

const componentBySlotPrefix: Record<string, string> = {
  alert: "Alert",
  badge: "Badge",
  button: "Button",
  "button-group": "ButtonGroup",
  card: "Card",
  checkbox: "Checkbox",
  "dropdown-menu": "DropdownMenu",
  input: "Input",
  select: "Select",
  sidebar: "Sidebar",
  switch: "Switch",
  tabs: "Tabs",
  textarea: "Textarea",
  toggle: "Toggle",
};

const semanticClassFragments = [
  "background-",
  "text-",
  "border-",
  "ring-",
  "shadow-",
  "rounded-",
  "muted",
  "foreground",
  "primary",
  "danger",
  "warning",
  "success",
  "info",
  "card",
  "popover",
];

export function isDesignSystemInspectorTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INSPECTOR_SELECTOR));
}

function getElementSlot(element: HTMLElement) {
  return (
    element.getAttribute("data-slot") ?? element.getAttribute("data-ds-slot")
  );
}

function getElementComponent(element: HTMLElement) {
  const slot = getElementSlot(element);
  return (
    element.getAttribute("data-ds-component") ?? getComponentFromSlot(slot)
  );
}

function getInspectableAncestors(target: Element) {
  const ancestors: HTMLElement[] = [];
  let current: HTMLElement | null =
    target instanceof HTMLElement ? target : target.closest<HTMLElement>("*");

  while (current) {
    if (current.matches(INSPECTABLE_SELECTOR)) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }

  return ancestors;
}

function getEntryInspectableElement(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  if (isDesignSystemInspectorTarget(target)) return null;

  const ancestors = getInspectableAncestors(target);
  const nearest = ancestors[0];
  if (!nearest) return target instanceof HTMLElement ? target : null;

  const nearestComponent = getElementComponent(nearest);
  const sameComponentAncestors = nearestComponent
    ? ancestors.filter(
        (ancestor) => getElementComponent(ancestor) === nearestComponent,
      )
    : [];

  if (sameComponentAncestors.length >= 2) {
    return sameComponentAncestors[sameComponentAncestors.length - 2] ?? nearest;
  }

  return nearest;
}

function getScopedInspectableElement(
  target: EventTarget | null,
  scope: HTMLElement,
) {
  if (!(target instanceof Element)) return null;
  if (isDesignSystemInspectorTarget(target)) return null;
  if (!scope.contains(target)) return null;

  let current: HTMLElement | null =
    target instanceof HTMLElement ? target : target.closest<HTMLElement>("*");

  while (current && current !== scope) {
    if (current.matches(INSPECTABLE_SELECTOR)) {
      return current;
    }
    current = current.parentElement;
  }

  return target instanceof HTMLElement && target !== scope ? target : null;
}

function getComponentFromSlot(slot: string | null) {
  if (!slot) return null;
  const prefix = Object.keys(componentBySlotPrefix)
    .sort((a, b) => b.length - a.length)
    .find(
      (candidate) => slot === candidate || slot.startsWith(`${candidate}-`),
    );
  return prefix ? componentBySlotPrefix[prefix] : null;
}

function parseProps(value: string | null) {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as Record<
      string,
      string | number | boolean
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getClassNames(element: HTMLElement) {
  const className = element.getAttribute("class");
  return className ? className.split(/\s+/).filter(Boolean) : [];
}

function getSemanticClasses(classNames: string[]) {
  return classNames.filter((className) =>
    semanticClassFragments.some((fragment) => className.includes(fragment)),
  );
}

function getTextSnippet(element: HTMLElement) {
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function hasRawColor(className: string) {
  return (
    /\[(?:#|rgb|hsl|oklch|color-mix)/.test(className) ||
    /(?:^|:)(?:bg|text|border|ring)-(?:red|green|blue|yellow|orange|zinc|gray)-\d/.test(
      className,
    )
  );
}

function buildFindings({
  component,
  customClassName,
  styleAttribute,
  classNames,
}: {
  component: string | null;
  customClassName: string | null;
  styleAttribute: string | null;
  classNames: string[];
}) {
  const findings: DesignSystemInspection["findings"] = [];
  const rawColorClasses = classNames.filter(hasRawColor);

  if (!component) {
    findings.push({
      tone: "warning",
      text: "No design-system component metadata found.",
    });
  }

  if (customClassName) {
    findings.push({
      tone: "warning",
      text: `Local className: ${customClassName}`,
    });
  }

  if (styleAttribute) {
    findings.push({
      tone: "warning",
      text: `Inline style: ${styleAttribute}`,
    });
  }

  if (rawColorClasses.length > 0) {
    findings.push({
      tone: "warning",
      text: `Raw color utility: ${rawColorClasses.slice(0, 4).join(" ")}`,
    });
  }

  if (findings.length === 0) {
    findings.push({
      tone: "info",
      text: "No local className, inline style, or raw color utility detected on this element.",
    });
  }

  return findings;
}

export function collectDesignSystemInspection(
  target: EventTarget | null,
  options: { scope?: HTMLElement } = {},
) {
  const element = options.scope
    ? getScopedInspectableElement(target, options.scope)
    : getEntryInspectableElement(target);
  if (!element) return null;

  const slot = getElementSlot(element);
  const component = getElementComponent(element);
  const source =
    element.getAttribute("data-ds-source") ??
    (component ? sourceByComponent[component] : null);
  const variant = element.getAttribute("data-ds-variant");
  const size = element.getAttribute("data-ds-size");
  const props = parseProps(element.getAttribute("data-ds-props"));
  const customClassName = element.getAttribute("data-ds-custom-class");
  const classNames = getClassNames(element);
  const styleAttribute = element.getAttribute("style");
  const computedStyle = getComputedStyle(element);
  const tagName = element.tagName.toLowerCase();

  return {
    element,
    tagName,
    label: component ?? slot ?? tagName,
    component,
    slot,
    source,
    variant,
    size,
    props,
    customClassName,
    classNames,
    semanticClasses: getSemanticClasses(classNames),
    styleAttribute,
    textSnippet: getTextSnippet(element),
    role: element.getAttribute("role"),
    ariaLabel: element.getAttribute("aria-label"),
    computed: [
      { label: "display", value: computedStyle.display },
      { label: "color", value: computedStyle.color },
      { label: "background", value: computedStyle.backgroundColor },
      { label: "border", value: computedStyle.borderColor },
      { label: "radius", value: computedStyle.borderRadius },
      { label: "font", value: computedStyle.fontFamily },
      { label: "font size", value: computedStyle.fontSize },
      { label: "padding", value: computedStyle.padding },
    ].filter((item) => item.value && item.value !== "normal"),
    findings: buildFindings({
      component,
      customClassName,
      styleAttribute,
      classNames,
    }),
  } satisfies DesignSystemInspection;
}

export function getElementRect(element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}
