import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconSparkles,
} from "@tabler/icons-react";
import { Mic, Plus, RefreshCw, Search, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionSectionTrigger,
  AccordionTrigger,
} from "@/shared/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/shared/ui/alert-dialog";
import { AspectRatio } from "@/shared/ui/aspect-ratio";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { Badge } from "@/shared/ui/badge";
import { BerdLoader } from "@/shared/ui/berd-loader";
import { BerdLoaderInline } from "@/shared/ui/berd-loader-inline";
import {
  BERD_LOADER_INLINE_LOOP_MS,
  BERD_LOADER_LOOP_MS,
} from "@/shared/ui/berd-loader-timing";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage as BreadcrumbCurrentPage,
  BreadcrumbSeparator,
  BreadcrumbTrail,
} from "@/shared/ui/breadcrumb";
import {
  Button,
  buttonVariants,
  isButtonDestructiveEmphasis,
} from "@/shared/ui/button";
import { AgentTileButton } from "@/shared/ui/agent-tile-button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { GlassButton } from "@/shared/ui/glass-button";
import { JumpToLatestButton } from "@/shared/ui/jump-to-latest-button";
import { PageHeaderButton } from "@/shared/ui/page-header-button";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";
import { VoiceConversationButton } from "@/shared/ui/voice-conversation-button";
import { ButtonGroup, ButtonGroupText } from "@/shared/ui/button-group";
import { Calendar } from "@/shared/ui/calendar";
import { Carousel, CarouselContent, CarouselItem } from "@/shared/ui/carousel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/shared/ui/command";
import { ContextualTip } from "@/shared/ui/contextual-tip";
import { designSystemComponentManifest } from "@/features/design-system/generated/componentManifest";
import { DetailField } from "@/shared/ui/detail-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/shared/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { BerdLogo } from "@/shared/ui/BerdLogo";
import { FormItem } from "@/shared/ui/form";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/shared/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/shared/ui/input-group";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/shared/ui/input-otp";
import { Label } from "@/shared/ui/label";
import { MainPanelLayout } from "@/shared/ui/MainPanelLayout";
import { Menubar, MenubarMenu, MenubarTrigger } from "@/shared/ui/menubar";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/shared/ui/navigation-menu";
import { PageHeader } from "@/shared/ui/page-shell";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/shared/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Progress } from "@/shared/ui/progress";
import {
  RadioGroup,
  RadioGroupCard,
  RadioGroupItem,
} from "@/shared/ui/radio-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/shared/ui/resizable";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Separator } from "@/shared/ui/separator";
import { SessionActivityIndicator } from "@/shared/ui/SessionActivityIndicator";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/shared/ui/sheet";
import { Skeleton } from "@/shared/ui/skeleton";
import { Slider } from "@/shared/ui/slider";
import { Spinner } from "@/shared/ui/spinner";
import { SplitButton } from "@/shared/ui/split-button";
import { Switch } from "@/shared/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Input } from "@/shared/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Textarea } from "@/shared/ui/textarea";
import { Toggle } from "@/shared/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import {
  DESIGN_SYSTEM_ALL_COMPONENT_SECTIONS,
  DESIGN_SYSTEM_COMPONENT_SECTIONS,
  DESIGN_SYSTEM_CORE_SECTIONS,
  DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS,
  type DesignSystemSection,
} from "./designSystemSections";
import { ComponentPlayground } from "./explorer/ComponentPlayground";
import { ConversationAnatomyPage } from "./ConversationAnatomyPage";
import globalsCssSource from "../../../shared/styles/globals.css?raw";

type ButtonVariant = NonNullable<
  React.ComponentProps<typeof Button>["variant"]
>;
type ButtonSize = NonNullable<React.ComponentProps<typeof Button>["size"]>;
type ButtonFeedbackState = NonNullable<
  React.ComponentProps<typeof Button>["feedbackState"]
>;
type ButtonLoadingVisual = NonNullable<
  React.ComponentProps<typeof Button>["loadingVisual"]
>;
type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;
type ButtonGroupOrientation = NonNullable<
  React.ComponentProps<typeof ButtonGroup>["orientation"]
>;
type TabsVariant = NonNullable<
  React.ComponentProps<typeof TabsList>["variant"]
>;
type SelectSize = NonNullable<
  React.ComponentProps<typeof SelectTrigger>["size"]
>;
type ToggleGroupVariant = NonNullable<
  React.ComponentProps<typeof ToggleGroup>["variant"]
>;
type ToggleGroupSize = NonNullable<
  React.ComponentProps<typeof ToggleGroup>["size"]
>;
type SwitchLabelPosition = "none" | "start" | "end";
type ToggleGroupSelectionType = "single" | "multiple";
type AlertVariant = "default" | "destructive";
type DropdownMenuItemVariant = "default" | "destructive";
type AccordionTriggerStyle = "default" | "section";
type AccordionBehavior = "single" | "multiple";
type AccordionIndicatorPosition = "start" | "end" | "none";
type AlertDialogActionTone = "default" | "destructive";
type AlertDialogDescriptionLength = "short" | "detailed" | "long";
type BreadcrumbTreatment = "default" | "top-bar";
type BreadcrumbDepth = "root" | "section" | "detail";
type ManifestItem = (typeof designSystemComponentManifest)[number];

const componentPageDescriptions: Partial<Record<string, string>> = {
  Accordion:
    "Disclosure stacks for progressive detail, with source-owned slots and Radix state surfaced from the generated manifest.",
  "Alert Dialog":
    "Blocking confirmation surfaces where modal structure, copy hierarchy, and action placement need to stay consistent.",
  "Aspect Ratio":
    "A layout primitive for fixed-ratio media and previews that should resize predictably across containers.",
  Avatar:
    "Compact identity marks for people, agents, and entities, including fallback behavior.",
  "Berd Loader":
    "Branded Berd activity mark for startup, active sessions, and agent work states.",
  Breadcrumb:
    "Hierarchy trails for wayfinding through nested pages and object detail surfaces.",
  Calendar:
    "Date picking structure built from shared navigation, selection, and focus treatments.",
  Card: "Contained content surfaces that carry the app's card background, border, typography, and elevation tokens.",
  Carousel:
    "Horizontal browsing primitives for grouped content where navigation and item framing need to stay aligned.",
  "Chart Container":
    "Chart framing and theme helpers used to bind data visualization colors back to the token system.",
  Checkbox:
    "Binary selection controls with checked, unchecked, disabled, and invalid states.",
  Collapsible:
    "Low-level show and hide behavior for compact sections and advanced disclosure patterns.",
  Command:
    "Searchable command surfaces for fast filtering, keyboard navigation, and grouped actions.",
  "Confirm Dialog":
    "Application-level confirmation composition built from dialog primitives and destructive action treatment.",
  "Context Menu":
    "Pointer-invoked action menus with nested, checkbox, radio, shortcut, and destructive item states.",
  "Contextual Tip":
    "Inline guidance surfaces for teaching without interrupting the surrounding workflow.",
  "Detail Field": "Label/value presentation for metadata-heavy detail pages.",
  Dialog:
    "Modal surfaces for focused workflows, with shared overlay, title, description, and footer structure.",
  Drawer:
    "Edge-anchored modal surfaces for workflows that benefit from spatial continuity.",
  "File Context Menu":
    "File-specific action menu composition for copying paths and related file operations.",
  Form: "Form composition primitives that connect fields, labels, descriptions, and validation messages.",
  "Berd Logo":
    "Animated Berd brand mark wrapper around the shared icon asset. The sidebar uses the icon directly, so this wrapper currently has no product imports.",
  "Hover Card":
    "Hover-triggered supporting information with popover surface and motion tokens.",
  "Image Lightbox":
    "Focused image inspection surface with overlay, navigation, and close affordances.",
  "Input Group":
    "Compound text input layouts with inline or block addons, buttons, and controls.",
  "Input OTP":
    "Segmented one-time-code entry with predictable slot sizing and focus styling.",
  Input:
    "Single-line text entry with default and ghost treatments, invalid state, and placeholder tokens.",
  Label:
    "Accessible field labels that connect copy hierarchy to control state.",
  "Main Panel Layout":
    "Primary app content framing used by major product surfaces.",
  Menubar:
    "Top-level command menus with keyboard navigation, nested groups, shortcuts, and selected states.",
  "Navigation Menu":
    "Structured navigation primitives for larger destination sets and nested menus.",
  "Page Columns":
    "Two-column page structure for detail and settings screens that need adjustable balance.",
  "Detail Page Shell":
    "Detail-page framing for back navigation, headers, metadata, and main content.",
  Pagination:
    "Paged navigation controls with active, previous, next, and overflow affordances.",
  Popover:
    "Anchored floating surfaces for compact secondary controls and contextual content.",
  Progress:
    "Linear completion feedback tied to primary color and track tokens.",
  "Radio Group":
    "Single-choice controls with grouped keyboard behavior, selected state tokens, and an optional full-row card treatment.",
  "Resizable Handle": "Drag handle affordances for resizable panel layouts.",
  "Scroll Area":
    "Custom scroll containers that preserve overlay and scrollbar consistency.",
  "Searchable Select":
    "Combobox composition for choosing from longer option sets with filtering.",
  "Search Bar":
    "Search input composition with icon placement and compact size variants.",
  Separator:
    "Semantic dividers for separating related content without adding visual weight.",
  "Session Activity Indicator":
    "Session status feedback for running, idle, and transitional chat states.",
  "Settings Page":
    "Settings surface layout primitives for consistent page headings and content sections.",
  "Settings Section":
    "Settings section hierarchy with a standard H2 and 44px spacing between peer groups.",
  "Settings Row":
    "Aligned settings content with optional supporting copy and flexible action or detail slots.",
  Sheet:
    "Side-panel modal surfaces for secondary workflows and mobile-friendly overlays.",
  Sidebar:
    "Application sidebar primitives for grouped navigation, rail behavior, and nested menus. Nav labels use regular weight via --sidebar-nav-font-weight and SIDEBAR_NAV_TEXT_CLASS.",
  Skeleton:
    "Loading placeholders that preserve layout while async content resolves.",
  Slider:
    "Range input controls with track, range, thumb, and disabled treatments.",
  Toaster:
    "Toast notification host that applies shared color and surface tokens.",
  Spinner: "Inline progress indicator for loading states where space is tight.",
  "Split Button":
    "A primary action paired with a dropdown of alternate actions.",
  Switch:
    "Binary setting controls with checked, unchecked, focus, and disabled treatments.",
  Table:
    "Dense data presentation primitives for rows, headers, captions, and hover states.",
  Textarea:
    "Multi-line text entry with shared border, placeholder, invalid, and disabled states.",
  Toggle: "Standalone pressed-state controls for lightweight mode switching.",
  Tooltip:
    "Short hover or focus labels for controls that need compact explanation.",
};

const otpPreviewSlots = [
  "slot-1",
  "slot-2",
  "slot-3",
  "slot-4",
  "slot-5",
  "slot-6",
];
const scrollAreaPreviewRows = [
  "Scroll row 1",
  "Scroll row 2",
  "Scroll row 3",
  "Scroll row 4",
  "Scroll row 5",
  "Scroll row 6",
  "Scroll row 7",
  "Scroll row 8",
];
const accordionItems = [
  {
    value: "first",
    title: "Component anatomy",
    meta: "4 slots",
    content:
      "Trigger, item, content, and root slots keep disclosure structure predictable.",
  },
  {
    value: "second",
    title: "State behavior",
    meta: "Radix state",
    content:
      "Open, closed, focus-visible, hover, and disabled states are surfaced through data attributes and shared tokens.",
  },
  {
    value: "third",
    title: "Longer content",
    meta: "Wrapping",
    content:
      "Use this row to check content spacing, animation rhythm, and how the trigger alignment holds when the panel carries more explanatory copy.",
  },
] as const;
const accordionTriggerStyleOptions = [
  { label: "Default trigger", value: "default" },
  { label: "Section trigger", value: "section" },
] satisfies Array<{ label: string; value: AccordionTriggerStyle }>;
const accordionBehaviorOptions = [
  { label: "Single open", value: "single" },
  { label: "Multiple open", value: "multiple" },
] satisfies Array<{ label: string; value: AccordionBehavior }>;
const accordionIndicatorPositionOptions = [
  { label: "End", value: "end" },
  { label: "Start", value: "start" },
  { label: "None", value: "none" },
] satisfies Array<{ label: string; value: AccordionIndicatorPosition }>;
const alertDialogCopy = {
  trigger: "Delete project",
  title: "Delete project?",
  shortDescription: "This action permanently deletes the project.",
  detailedDescription:
    "This removes the project, its saved context, and any project-specific settings. Existing chat history stays in your archive.",
  action: "Delete project",
};
const alertDialogActionToneOptions = [
  { label: "Default", value: "default" },
  { label: "Destructive", value: "destructive" },
] satisfies Array<{ label: string; value: AlertDialogActionTone }>;
const alertDialogDescriptionLengthOptions = [
  { label: "Short", value: "short" },
  { label: "Detailed", value: "detailed" },
  { label: "Long wrap", value: "long" },
] satisfies Array<{ label: string; value: AlertDialogDescriptionLength }>;
const buttonGroupPlaygroundOptions = [
  { value: "one", label: "Button one" },
  { value: "two", label: "Button two" },
  { value: "three", label: "Button three" },
] as const;
type ButtonGroupPlaygroundValue =
  (typeof buttonGroupPlaygroundOptions)[number]["value"];

type RuntimeToken = {
  name: string;
  description?: string;
  definition?: string;
  sources?: string[];
  layer?: string;
};

const shapeTokens: RuntimeToken[] = [
  {
    name: "--radius-xs",
    description:
      "Sub-cards nested inside sm containers; badges and status chips.",
  },
  {
    name: "--radius-sm",
    description: "Sidebar nav items, theme tiles, picker tiles, nested cards.",
  },
  {
    name: "--radius-md",
    description:
      "Base card surface — sidebar panel, settings cards, widgets, chat surface.",
  },
  {
    name: "--radius-lg",
    description: "Largest framing cards — outer panel containers.",
  },
  {
    name: "--radius-composer",
    description: "Chat composer one-off — deliberate signature shape.",
  },
];

const spacingTokens: RuntimeToken[] = [
  {
    name: "--spacing-app-top-bar",
    description: "Top app chrome height.",
  },
  {
    name: "--spacing-app-top-bar-leading",
    description: "Leading space reserved for macOS traffic lights.",
  },
  {
    name: "--spacing-app-top-bar-leading-compact",
    description:
      "Compact leading space used when native controls do not occupy the left edge.",
  },
  {
    name: "--spacing-app-top-bar-trailing",
    description: "Default trailing space in the app top bar.",
  },
  {
    name: "--spacing-app-top-bar-control",
    description: "Top bar control footprint.",
  },
  {
    name: "--spacing-app-top-bar-button-gap",
    description: "Gap between adjacent top bar icon controls.",
  },
  {
    name: "--spacing-app-panel-gutter-top",
    description: "Top gutter between app chrome and panels.",
  },
  {
    name: "--spacing-app-panel-gutter-inline",
    description:
      "Left and right gutter between app panels and the window edge.",
  },
  {
    name: "--spacing-app-panel-gutter-bottom",
    description:
      "Bottom gutter between resizable app panels and the window edge.",
  },
  {
    name: "--spacing-input",
    description: "Default form control height.",
  },
  {
    name: "--spacing-input-sm",
    description: "Small form control height.",
  },
  {
    name: "--spacing-button",
    description: "Default button height.",
  },
  {
    name: "--spacing-button-sm",
    description: "Small button height.",
  },
];

const appChromeColorTokens: RuntimeToken[] = [
  {
    name: "--app-top-bar-control-fg",
    description:
      "Deep charcoal (#242424) for controls beside the breadcrumb trail in light theme; follows foreground in dark theme.",
  },
  {
    name: "--app-top-bar-control-fg-disabled",
    description:
      "35% opacity of --app-top-bar-control-fg for inactive back/forward controls.",
  },
  {
    name: "--app-top-bar-control-hover-opacity",
    description:
      "70% opacity hover affordance for clickable top bar icons and breadcrumb links.",
  },
  {
    name: "--sidebar-section-action-bg",
    description: "Sidebar section header action pill background.",
  },
  {
    name: "--sidebar-section-action-fg",
    description: "Sidebar section header action pill label color.",
  },
  {
    name: "--sidebar-section-action-bg-hover",
    description: "Sidebar section header action pill hover background.",
  },
  {
    name: "--sidebar-section-action-fg-hover",
    description: "Sidebar section header action pill hover label color.",
  },
];

const elevationTokens: RuntimeToken[] = [
  { name: "--shadow-mini", description: "Low emphasis raised surface." },
  { name: "--shadow-mini-inset", description: "Inset low emphasis shadow." },
  { name: "--shadow-btn", description: "Button shadow." },
  { name: "--shadow-card", description: "Card shadow." },
  { name: "--shadow-elevated", description: "Elevated panel shadow." },
  { name: "--shadow-popover", description: "Popover shadow." },
  { name: "--shadow-modal", description: "Modal shadow." },
  {
    name: "--shadow-sidebar-panel-elevated",
    description:
      "Sidebar panel hover shadow (modal blur, +30px right, +42px down, 5% opacity light).",
  },
  { name: "--shadow-kbd", description: "Keyboard key shadow." },
  {
    name: "--shadow-date-field-focus",
    description: "Date field focus treatment.",
  },
  {
    name: "--shadow-agent-profile-avatar",
    description: "Agent profile avatar preview shadow.",
  },
  {
    name: "--shadow-agent-profile-affordance",
    description: "Agent profile floating affordance shadow.",
  },
  {
    name: "--shadow-agent-profile-input-hover",
    description: "Agent profile input hover shadow.",
  },
  {
    name: "--shadow-agent-profile-input-focus",
    description: "Agent profile input focus shadow.",
  },
];

const typographyTokens = [
  "--font-sans",
  "--font-display",
  "--font-mono",
  "--sidebar-nav-font-weight",
  "--text-xxs",
  "--text-app-top-bar-title",
  "--text-app-top-bar-title-leading",
  "--text-app-top-bar-icon",
  "--app-top-bar-control-fg",
  "--app-top-bar-control-fg-disabled",
  "--app-top-bar-control-hover-opacity",
];

function getManifestItem(name: string) {
  return designSystemComponentManifest.find(
    (component) => component.name === name,
  );
}

const componentInventory: ManifestItem[] =
  DESIGN_SYSTEM_ALL_COMPONENT_SECTIONS.flatMap((section) => {
    const item = getManifestItem(section.label);
    return item ? [item] : [];
  });
const unusedComponentLabels = new Set(
  DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.map((section) => section.label),
);

function getCvaVariantValues({
  componentName,
  cvaName,
  variantName,
}: {
  componentName: string;
  cvaName: string;
  variantName: string;
}) {
  const cva = getManifestItem(componentName)?.cva.find(
    (item) => item.name === cvaName,
  );
  const variants = cva?.variants as
    | Record<string, readonly string[]>
    | undefined;

  return [...(variants?.[variantName] ?? [])];
}

function getComponentVariantOptions<TValue extends string>(configuration: {
  componentName: string;
  cvaName: string;
  variantName: string;
}) {
  return getCvaVariantValues(configuration).map((value) => ({
    label: value,
    value: value as TValue,
  }));
}

function formatManifestVariants(item: ManifestItem) {
  const variants = item.cva.flatMap((cva) =>
    Object.entries(cva.variants).map(
      ([variantName, values]) => `${variantName}: ${values.join(", ")}`,
    ),
  );

  return variants.length > 0 ? variants.join("; ") : "None";
}

function formatManifestSlots(item: ManifestItem) {
  return item.slots.length > 0 ? item.slots.join(", ") : "None";
}

const buttonVariantOptions = getComponentVariantOptions<ButtonVariant>({
  componentName: "Button",
  cvaName: "buttonVariants",
  variantName: "variant",
});

const buttonSizeOptions = getComponentVariantOptions<ButtonSize>({
  componentName: "Button",
  cvaName: "buttonVariants",
  variantName: "size",
});

const buttonFeedbackStateOptions = [
  { label: "idle", value: "idle" },
  { label: "loading", value: "loading" },
  { label: "success", value: "success" },
  { label: "error", value: "error" },
] satisfies Array<{ label: string; value: ButtonFeedbackState }>;

const buttonLoadingVisualOptions = [
  { label: "text", value: "text" },
  { label: "spinner", value: "spinner" },
  { label: "spinner + text", value: "spinnerText" },
] satisfies Array<{ label: string; value: ButtonLoadingVisual }>;

const badgeVariantOptions = getComponentVariantOptions<BadgeVariant>({
  componentName: "Badge",
  cvaName: "badgeVariants",
  variantName: "variant",
});

const alertVariantOptions = getComponentVariantOptions<AlertVariant>({
  componentName: "Alert",
  cvaName: "alertVariants",
  variantName: "variant",
});

const tabsVariantOptions = getComponentVariantOptions<TabsVariant>({
  componentName: "Tabs",
  cvaName: "tabsListVariants",
  variantName: "variant",
});

const selectSizeOptions = [
  { label: "default", value: "default" },
  { label: "sm", value: "sm" },
] satisfies Array<{ label: string; value: SelectSize }>;

const toggleGroupVariantOptions = [
  { label: "default", value: "default" },
  { label: "outline", value: "outline" },
] satisfies Array<{ label: string; value: ToggleGroupVariant }>;

const toggleGroupSizeOptions = [
  { label: "default", value: "default" },
  { label: "sm", value: "sm" },
  { label: "lg", value: "lg" },
] satisfies Array<{ label: string; value: ToggleGroupSize }>;

const switchLabelPositionOptions = [
  { label: "None", value: "none" },
  { label: "Label before", value: "start" },
  { label: "Label after", value: "end" },
] satisfies Array<{ label: string; value: SwitchLabelPosition }>;

function isIconButtonSize(size: ButtonSize) {
  return size.startsWith("icon");
}

type TokenColorRow = {
  anatomy: string;
  state: string;
  background?: string;
  textIcon?: string;
  border?: string;
};

type TokenTextRow = {
  anatomy: string;
  size: string;
  weight: string;
};

type TokenTimingRow = {
  token: string;
  value: string;
  use: string;
};

function uniqueValues(values: string[]) {
  return Array.from(new Set(values));
}

const buttonTextSizeBySize = {
  xxs: "text-[11px]",
  xs: "text-xs",
  sm: "text-xs",
  compact: "text-sm",
  default: "text-sm",
  lg: "text-sm",
  icon: "text-sm",
  "icon-xxs": "text-sm",
  "icon-xs": "text-xs",
  "icon-sm": "text-sm",
  "icon-top-bar": "text-sm",
  "icon-pill-sm": "text-sm",
  "icon-lg": "text-sm",
} satisfies Record<ButtonSize, string>;

const buttonVariantColorRows: Record<ButtonVariant, TokenColorRow[]> = {
  primary: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--primary",
      textIcon: "--primary-foreground",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--primary / 90%",
      textIcon: "--primary-foreground",
    },
  ],
  subtle: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--accent",
      textIcon: "--accent-foreground",
      border: "none",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--accent-hover",
      textIcon: "--accent-foreground",
      border: "none",
    },
  ],
  alert: [
    {
      anatomy: "Button",
      state: "Default",
      background: "transparent",
      textIcon: "currentColor",
      border: "currentColor / 30%",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "currentColor / 10%",
      textIcon: "currentColor",
      border: "currentColor / 30%",
    },
  ],
  outline: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--background",
      textIcon: "--foreground",
      border: "--input",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--accent",
      textIcon: "--accent-foreground",
      border: "--input",
    },
  ],
  ghost: [
    {
      anatomy: "Button",
      state: "Default",
      background: "transparent",
      textIcon: "--foreground",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--accent",
      textIcon: "--accent-foreground",
    },
  ],
  link: [
    {
      anatomy: "Button",
      state: "Default",
      background: "transparent",
      textIcon: "--primary",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "transparent",
      textIcon: "--primary",
    },
  ],
};

const buttonIconGhostColorRows: TokenColorRow[] = [
  {
    anatomy: "Button",
    state: "Default",
    background: "transparent",
    textIcon: "--muted-foreground",
  },
  {
    anatomy: "Button",
    state: "Hover",
    background: "transparent",
    textIcon: "--foreground",
  },
  {
    anatomy: "Button",
    state: "Open",
    background: "transparent",
    textIcon: "--foreground",
  },
];

function withDisabledOpacity(value?: string) {
  if (!value || value === "none") {
    return "none";
  }

  if (value === "transparent") {
    return "transparent";
  }

  return `${value} / 50%`;
}

const buttonDestructiveColorRows: Partial<
  Record<ButtonVariant, TokenColorRow[]>
> = {
  primary: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--destructive",
      textIcon: "--destructive-foreground",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--destructive / 90%",
      textIcon: "--destructive-foreground",
    },
  ],
  outline: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--background",
      textIcon: "--destructive",
      border: "--destructive / 30%",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--destructive / 8%",
      textIcon: "--destructive",
      border: "--destructive / 40%",
    },
  ],
  subtle: [
    {
      anatomy: "Button",
      state: "Default",
      background: "--destructive / 10%",
      textIcon: "--destructive",
      border: "none",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--destructive / 16%",
      textIcon: "--destructive",
      border: "none",
    },
  ],
  ghost: [
    {
      anatomy: "Button",
      state: "Default",
      background: "transparent",
      textIcon: "--destructive",
    },
    {
      anatomy: "Button",
      state: "Hover",
      background: "--destructive / 10%",
      textIcon: "--destructive",
    },
  ],
};

function getButtonTokenDetails({
  variant,
  size,
  destructive = false,
}: {
  variant: ButtonVariant;
  size: ButtonSize;
  destructive?: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  const destructiveRows = destructive
    ? buttonDestructiveColorRows[variant]
    : undefined;
  const colorRows =
    destructiveRows ??
    (variant === "ghost" && isIconButtonSize(size)
      ? buttonIconGhostColorRows
      : buttonVariantColorRows[variant]);
  const defaultRow = colorRows.find((row) => row.state === "Default");
  const disabledRows = colorRows.some((row) => row.state === "Disabled")
    ? []
    : [
        {
          anatomy: "Button",
          state: "Disabled",
          background: withDisabledOpacity(defaultRow?.background),
          textIcon: withDisabledOpacity(defaultRow?.textIcon),
          border: withDisabledOpacity(defaultRow?.border),
        } satisfies TokenColorRow,
      ];

  return {
    colorRows: [...colorRows, ...disabledRows],
    textRows: [
      {
        anatomy: "Button label",
        size: buttonTextSizeBySize[size],
        weight: "font-normal",
      },
    ],
  };
}

function getSwitchTokenDetails({
  checked,
  disabled,
  labelPosition,
}: {
  checked: boolean;
  disabled: boolean;
  labelPosition: SwitchLabelPosition;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  const state = checked ? "Checked" : "Unchecked";
  const opacitySuffix = disabled ? " / 50%" : "";
  const colorRows: TokenColorRow[] = [
    {
      anatomy: "Track",
      state,
      background: `${checked ? "--primary" : "--secondary"}${opacitySuffix}`,
      border: "transparent",
    },
    {
      anatomy: "Thumb",
      state,
      background: `--primary-foreground${opacitySuffix}`,
    },
  ];

  if (labelPosition !== "none") {
    colorRows.push({
      anatomy: "Label",
      state: disabled ? "Disabled" : "Default",
      textIcon: disabled ? "--foreground / 50%" : "--foreground",
    });
  }

  return {
    colorRows,
    textRows:
      labelPosition === "none"
        ? []
        : [
            {
              anatomy: "Label",
              size: "text-sm",
              weight: "font-medium",
            },
          ],
  };
}

function getAccordionTokenDetails({
  triggerStyle,
  disabledItem,
}: {
  triggerStyle: AccordionTriggerStyle;
  disabledItem: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  return {
    colorRows: [
      {
        anatomy: "Trigger",
        state: "Default",
        background: "transparent",
        textIcon: "--foreground",
        border: "none",
      },
      {
        anatomy: "Trigger",
        state: "Focus",
        background: "transparent",
        textIcon: "--foreground",
        border: "--ring",
      },
      {
        anatomy: "Indicator",
        state: "Default",
        background: "none",
        textIcon: "--muted-foreground",
        border: "none",
      },
      {
        anatomy: "Content",
        state: "Open",
        background: "transparent",
        textIcon: "--foreground",
        border: "none",
      },
      ...(disabledItem
        ? [
            {
              anatomy: "Disabled trigger",
              state: "Disabled",
              background: "transparent",
              textIcon: "--foreground / 50%",
              border: "none",
            } satisfies TokenColorRow,
          ]
        : []),
    ],
    textRows: [
      {
        anatomy: triggerStyle === "section" ? "Section title" : "Trigger label",
        size: triggerStyle === "section" ? "text-base" : "text-sm",
        weight: "font-normal",
      },
      ...(triggerStyle === "section"
        ? [
            {
              anatomy: "Section meta",
              size: "text-xs",
              weight: "font-light",
            } satisfies TokenTextRow,
          ]
        : []),
      {
        anatomy: "Content",
        size: "text-sm",
        weight: "font-normal",
      },
    ],
  };
}

function getAlertDialogDescription(length: AlertDialogDescriptionLength) {
  if (length === "short") {
    return alertDialogCopy.shortDescription;
  }

  if (length === "detailed") {
    return alertDialogCopy.detailedDescription;
  }

  return `${alertDialogCopy.detailedDescription} This longer copy checks how the modal handles wrapping, line length, and footer placement when confirmation language needs extra context.`;
}

function getAlertDialogTokenDetails({
  actionTone,
  triggerDisabled,
}: {
  actionTone: AlertDialogActionTone;
  triggerDisabled: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  const actionDefault =
    actionTone === "destructive"
      ? {
          background: "--destructive",
          textIcon: "--destructive-foreground",
        }
      : {
          background: "--primary",
          textIcon: "--primary-foreground",
        };

  return {
    colorRows: [
      {
        anatomy: "Overlay",
        state: "Open",
        background: "black / 50%",
        textIcon: "none",
        border: "none",
      },
      {
        anatomy: "Content",
        state: "Open",
        background: "--background",
        textIcon: "--foreground",
        border: "--border",
      },
      {
        anatomy: "Description",
        state: "Default",
        background: "transparent",
        textIcon: "--muted-foreground",
        border: "none",
      },
      {
        anatomy: "Cancel action",
        state: "Default",
        background: "--background",
        textIcon: "--foreground",
        border: "--input",
      },
      {
        anatomy: "Primary action",
        state: actionTone === "destructive" ? "Destructive" : "Default",
        background: actionDefault.background,
        textIcon: actionDefault.textIcon,
        border: "none",
      },
      ...(triggerDisabled
        ? [
            {
              anatomy: "Trigger",
              state: "Disabled",
              background: withDisabledOpacity(actionDefault.background),
              textIcon: withDisabledOpacity(actionDefault.textIcon),
              border: "none",
            } satisfies TokenColorRow,
          ]
        : []),
    ],
    textRows: [
      {
        anatomy: "Title",
        size: "text-lg",
        weight: "font-semibold",
      },
      {
        anatomy: "Description",
        size: "text-sm",
        weight: "font-normal",
      },
      {
        anatomy: "Action label",
        size: "text-sm",
        weight: "font-normal",
      },
    ],
  };
}

function getButtonGroupTokenDetails({ showText }: { showText: boolean }): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  return {
    colorRows: [
      {
        anatomy: "Button",
        state: "Default",
        background: "--background",
        textIcon: "--foreground",
        border: "--input",
      },
      {
        anatomy: "Button",
        state: "Hover",
        background: "--accent",
        textIcon: "--accent-foreground",
        border: "--input",
      },
      {
        anatomy: "Button",
        state: "Selected",
        background: "--secondary",
        textIcon: "--secondary-foreground",
      },
      {
        anatomy: "Button",
        state: "Disabled default",
        background: "--background / 50%",
        textIcon: "--foreground / 50%",
        border: "--input / 50%",
      },
      {
        anatomy: "Button",
        state: "Disabled selected",
        background: "--secondary / 50%",
        textIcon: "--secondary-foreground / 50%",
        border: "none",
      },
      ...(showText
        ? [
            {
              anatomy: "Label segment",
              state: "Default",
              background: "--muted",
              textIcon: "--foreground",
              border: "--border",
            } satisfies TokenColorRow,
          ]
        : []),
    ],
    textRows: [
      {
        anatomy: "Button label",
        size: "text-xs",
        weight: "font-normal",
      },
      ...(showText
        ? [
            {
              anatomy: "Label segment",
              size: "text-sm",
              weight: "font-medium",
            } satisfies TokenTextRow,
          ]
        : []),
    ],
  };
}

const badgeVariantColorRows: Record<BadgeVariant, TokenColorRow[]> = {
  default: [
    {
      anatomy: "Badge",
      state: "Default",
      background: "--primary",
      textIcon: "--primary-foreground",
      border: "transparent",
    },
    {
      anatomy: "Badge",
      state: "Clickable hover",
      background: "--primary / 90%",
      textIcon: "--primary-foreground",
      border: "transparent",
    },
  ],
  secondary: [
    {
      anatomy: "Badge",
      state: "Default",
      background: "--muted",
      textIcon: "--foreground",
      border: "transparent",
    },
    {
      anatomy: "Badge",
      state: "Clickable hover",
      background: "--muted / 90%",
      textIcon: "--foreground",
      border: "transparent",
    },
  ],
  destructive: [
    {
      anatomy: "Badge",
      state: "Default",
      background: "--destructive",
      textIcon: "--destructive-foreground",
      border: "transparent",
    },
    {
      anatomy: "Badge",
      state: "Clickable hover",
      background: "--destructive / 90%",
      textIcon: "--destructive-foreground",
      border: "transparent",
    },
  ],
  inverse: [
    {
      anatomy: "Badge",
      state: "Default",
      background: "--surface-chat-responding-pill-bg",
      textIcon: "--surface-chat-responding-pill-fg",
      border: "transparent",
    },
  ],
  outline: [
    {
      anatomy: "Badge",
      state: "Default",
      background: "transparent",
      textIcon: "--foreground",
      border: "--border",
    },
    {
      anatomy: "Badge",
      state: "Clickable hover",
      background: "--muted",
      textIcon: "--muted-foreground",
      border: "--border",
    },
  ],
};

function getBadgeTokenDetails({ variant }: { variant: BadgeVariant }): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  const rows = badgeVariantColorRows[variant];

  return {
    colorRows: rows.filter((row) => row.state === "Default"),
    textRows: [
      {
        anatomy: "Badge label",
        size: "text-xs",
        weight: "font-normal",
      },
    ],
  };
}

function getAlertTokenDetails({ variant }: { variant: AlertVariant }): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  return {
    colorRows:
      variant === "destructive"
        ? [
            {
              anatomy: "Alert",
              state: "Default",
              background: "--background",
              textIcon: "--destructive",
              border: "--border",
            },
            {
              anatomy: "Description",
              state: "Default",
              textIcon: "--destructive / 90%",
            },
          ]
        : [
            {
              anatomy: "Alert",
              state: "Default",
              background: "--background",
              textIcon: "--foreground",
              border: "--border",
            },
            {
              anatomy: "Description",
              state: "Default",
              textIcon: "--muted-foreground",
            },
          ],
    textRows: [
      {
        anatomy: "Title",
        size: "text-sm",
        weight: "font-semibold",
      },
      {
        anatomy: "Description",
        size: "text-sm",
        weight: "font-normal",
      },
    ],
  };
}

function getTabsTokenDetails({ variant }: { variant: TabsVariant }): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  if (variant === "weight") {
    return {
      colorRows: [
        {
          anatomy: "Tab list",
          state: "Default",
          background: "transparent",
          textIcon: "--muted-foreground",
        },
        {
          anatomy: "Tab trigger",
          state: "Default",
          background: "transparent",
          textIcon: "--muted-foreground",
        },
        {
          anatomy: "Tab trigger",
          state: "Hover",
          background: "transparent",
          textIcon: "--foreground",
        },
        {
          anatomy: "Tab trigger",
          state: "Active",
          background: "transparent",
          textIcon: "--foreground",
        },
        {
          anatomy: "Tab trigger",
          state: "Disabled",
          background: "transparent",
          textIcon: "--muted-foreground / 50%",
        },
      ],
      textRows: [
        {
          anatomy: "Tab trigger label",
          size: "text-sm",
          weight: "font-light to font-normal",
        },
      ],
    };
  }

  return {
    colorRows:
      variant === "buttons"
        ? [
            {
              anatomy: "Tab list",
              state: "Default",
              background: "transparent",
              textIcon: "--muted-foreground",
            },
            {
              anatomy: "Tab trigger",
              state: "Default",
              background: "transparent",
              textIcon: "--foreground",
            },
            {
              anatomy: "Tab trigger",
              state: "Hover",
              background: "--accent",
              textIcon: "--accent-foreground",
            },
            {
              anatomy: "Tab trigger",
              state: "Active",
              background: "--muted",
              textIcon: "--foreground",
            },
            {
              anatomy: "Tab trigger",
              state: "Disabled",
              background: "transparent",
              textIcon: "--foreground / 50%",
            },
          ]
        : [
            {
              anatomy: "Tab list",
              state: "Default",
              background: "--muted",
              textIcon: "--muted-foreground",
            },
            {
              anatomy: "Tab trigger",
              state: "Default",
              background: "transparent",
              textIcon: "--foreground",
              border: "transparent",
            },
            {
              anatomy: "Tab trigger",
              state: "Active",
              background: "--background",
              textIcon: "--foreground",
              border: "transparent",
            },
            {
              anatomy: "Tab trigger",
              state: "Disabled",
              background: "transparent",
              textIcon: "--foreground / 50%",
              border: "transparent",
            },
          ],
    textRows: [
      {
        anatomy: "Tab trigger label",
        size: variant === "buttons" ? "text-xs" : "text-sm",
        weight: variant === "buttons" ? "font-medium" : "font-normal",
      },
    ],
  };
}

function getBreadcrumbTokenDetails({
  depth,
  treatment,
  showCurrent,
}: {
  depth: BreadcrumbDepth;
  treatment: BreadcrumbTreatment;
  showCurrent: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  if (treatment === "top-bar") {
    return {
      colorRows: [
        {
          anatomy: "Toolbar icon",
          state: "Default",
          background: "transparent",
          textIcon: "--app-top-bar-control-fg",
        },
        {
          anatomy: "Toolbar icon",
          state: "Hover",
          background: "transparent",
          textIcon:
            "--app-top-bar-control-fg @ --app-top-bar-control-hover-opacity",
        },
        {
          anatomy: "History nav icon",
          state: "Disabled",
          background: "transparent",
          textIcon: "--app-top-bar-control-fg-disabled",
        },
        {
          anatomy: showCurrent ? "Root link" : "Root page",
          state: "Default",
          background: "transparent",
          textIcon: "--foreground",
        },
        ...(showCurrent
          ? [
              {
                anatomy: "Root link",
                state: "Hover",
                background: "transparent",
                textIcon: "--foreground @ --app-top-bar-control-hover-opacity",
              } satisfies TokenColorRow,
              {
                anatomy: "Section link",
                state: "Hover",
                background: "transparent",
                textIcon: "--foreground @ --app-top-bar-control-hover-opacity",
              } satisfies TokenColorRow,
              {
                anatomy: "Separator",
                state: depth === "detail" ? "Intermediate" : "Current",
                background: "transparent",
                textIcon:
                  depth === "detail" ? "--foreground" : "--muted-foreground",
              } satisfies TokenColorRow,
              ...(depth === "detail"
                ? [
                    {
                      anatomy: "Separator",
                      state: "Current",
                      background: "transparent",
                      textIcon: "--muted-foreground",
                    } satisfies TokenColorRow,
                  ]
                : []),
              {
                anatomy: depth === "detail" ? "Section link" : "Current page",
                state: "Default",
                background: "transparent",
                textIcon:
                  depth === "detail" ? "--foreground" : "--muted-foreground",
              } satisfies TokenColorRow,
              ...(depth === "detail"
                ? [
                    {
                      anatomy: "Current page",
                      state: "Default",
                      background: "transparent",
                      textIcon: "--muted-foreground",
                    } satisfies TokenColorRow,
                  ]
                : []),
            ]
          : []),
      ],
      textRows: [
        {
          anatomy: "Top bar trail",
          size: "text-[length:var(--text-app-top-bar-title)] (20px)",
          weight: "font-normal",
        },
      ],
    };
  }

  return {
    colorRows: [
      {
        anatomy: "Breadcrumb link",
        state: "Default",
        background: "transparent",
        textIcon: "--muted-foreground",
      },
      {
        anatomy: "Breadcrumb link",
        state: "Hover",
        background: "transparent",
        textIcon: "--foreground",
      },
      ...(showCurrent
        ? [
            {
              anatomy: "Current page",
              state: "Default",
              background: "transparent",
              textIcon: "--foreground",
            } satisfies TokenColorRow,
          ]
        : []),
    ],
    textRows: [
      {
        anatomy: "Breadcrumb item",
        size: "text-sm",
        weight: "font-normal",
      },
    ],
  };
}

const toggleGroupTextSizeBySize = {
  default: "text-sm",
  sm: "text-sm",
  lg: "text-sm",
} satisfies Record<ToggleGroupSize, string>;

function getToggleGroupTokenDetails({
  variant,
  size,
}: {
  variant: ToggleGroupVariant;
  size: ToggleGroupSize;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  return {
    colorRows: [
      {
        anatomy: "Toggle item",
        state: "Default",
        background: "transparent",
        textIcon: "--muted-foreground",
        border: variant === "outline" ? "--input" : "none",
      },
      {
        anatomy: "Toggle item",
        state: "Hover",
        background: "--accent",
        textIcon: "--foreground",
        border: variant === "outline" ? "--input" : "none",
      },
      {
        anatomy: "Toggle item",
        state: "Selected",
        background: "--muted",
        textIcon: "--foreground",
        border: variant === "outline" ? "--input" : "none",
      },
      {
        anatomy: "Toggle item",
        state: "Disabled",
        background: "transparent",
        textIcon: "--muted-foreground / 50%",
        border: variant === "outline" ? "--input / 50%" : "none",
      },
    ],
    textRows: [
      {
        anatomy: "Toggle item label",
        size: toggleGroupTextSizeBySize[size],
        weight: "font-normal",
      },
    ],
  };
}

function getSelectTokenDetails({
  disabled,
  open,
}: {
  disabled: boolean;
  open: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  return {
    colorRows: [
      {
        anatomy: "Trigger",
        state: "Default",
        background: "transparent",
        textIcon: "--foreground",
        border: "--input",
      },
      {
        anatomy: "Trigger",
        state: "Focus",
        background: "transparent",
        textIcon: "--foreground",
        border: "--ring",
      },
      {
        anatomy: "Trigger",
        state: "Disabled",
        background: "transparent",
        textIcon: "--foreground / 50%",
        border: "--input / 50%",
      },
      ...(open
        ? [
            {
              anatomy: "Menu surface",
              state: "Open",
              background: "--popover",
              textIcon: "--foreground",
              border: "--border",
            } satisfies TokenColorRow,
            {
              anatomy: "Menu item",
              state: "Default",
              background: "transparent",
              textIcon: "--foreground",
            } satisfies TokenColorRow,
            {
              anatomy: "Menu item",
              state: "Focus",
              background: "--muted",
              textIcon: "--foreground",
            } satisfies TokenColorRow,
          ]
        : []),
    ].filter((row) => !disabled || row.state !== "Focus"),
    textRows: [
      {
        anatomy: "Trigger value",
        size: "text-sm",
        weight: "font-normal",
      },
      ...(open
        ? [
            {
              anatomy: "Menu item label",
              size: "text-sm",
              weight: "font-normal",
            } satisfies TokenTextRow,
          ]
        : []),
    ],
  };
}

function getDropdownMenuTokenDetails({
  itemVariant,
  open,
}: {
  itemVariant: DropdownMenuItemVariant;
  open: boolean;
}): {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
} {
  const isDestructive = itemVariant === "destructive";

  return {
    colorRows: [
      {
        anatomy: "Trigger button",
        state: "Default",
        background: "--background",
        textIcon: "--foreground",
        border: "--input",
      },
      {
        anatomy: "Trigger button",
        state: "Hover",
        background: "--accent",
        textIcon: "--accent-foreground",
        border: "--input",
      },
      ...(open
        ? [
            {
              anatomy: "Menu surface",
              state: "Open",
              background: "--popover",
              textIcon: "--foreground",
              border: "--border",
            } satisfies TokenColorRow,
            {
              anatomy: "Menu item",
              state: "Default",
              background: "transparent",
              textIcon: isDestructive ? "--destructive" : "--foreground",
            } satisfies TokenColorRow,
            {
              anatomy: "Menu item",
              state: "Focus",
              background: isDestructive ? "--destructive / 10%" : "--muted",
              textIcon: isDestructive ? "--destructive" : "--foreground",
            } satisfies TokenColorRow,
          ]
        : []),
    ],
    textRows: [
      {
        anatomy: "Trigger label",
        size: "text-sm",
        weight: "font-normal",
      },
      ...(open
        ? [
            {
              anatomy: "Menu label",
              size: "text-sm",
              weight: "font-normal",
            } satisfies TokenTextRow,
            {
              anatomy: "Menu item label",
              size: "text-sm",
              weight: "font-normal",
            } satisfies TokenTextRow,
          ]
        : []),
    ],
  };
}

function TokenValue({ value }: { value?: string }) {
  return (
    <span className="font-mono text-[11px] text-foreground">
      {value || "none"}
    </span>
  );
}

function ComponentTokenDetails({
  colorRows,
  textRows,
  timingRows = [],
}: {
  colorRows: TokenColorRow[];
  textRows: TokenTextRow[];
  timingRows?: TokenTimingRow[];
}) {
  return (
    <div>
      <div className="mb-3">
        <p className="text-xs font-medium text-foreground">Tokens</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Focused on color states and text styling for the current preview.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Color
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-border bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Anatomy</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Background</th>
                  <th className="px-3 py-2 font-medium">Text / icon</th>
                  <th className="px-3 py-2 font-medium">Border</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {colorRows.map((row) => (
                  <tr key={`${row.anatomy}-${row.state}`}>
                    <td className="px-3 py-2 text-foreground">{row.anatomy}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.state}
                    </td>
                    <td className="px-3 py-2">
                      <TokenValue value={row.background} />
                    </td>
                    <td className="px-3 py-2">
                      <TokenValue value={row.textIcon} />
                    </td>
                    <td className="px-3 py-2">
                      <TokenValue value={row.border} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Text
          </p>
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-border bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Anatomy</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Weight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {textRows.map((row) => (
                  <tr key={row.anatomy}>
                    <td className="px-3 py-2 text-foreground">{row.anatomy}</td>
                    <td className="px-3 py-2">
                      <TokenValue value={row.size} />
                    </td>
                    <td className="px-3 py-2">
                      <TokenValue value={row.weight} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {timingRows.length > 0 ? (
          <div className="min-w-0">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Timing
            </p>
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="border-b border-border bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 font-medium">Value</th>
                    <th className="px-3 py-2 font-medium">Use</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {timingRows.map((row) => (
                    <tr key={row.token}>
                      <td className="px-3 py-2">
                        <TokenValue value={row.token} />
                      </td>
                      <td className="px-3 py-2">
                        <TokenValue value={row.value} />
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.use}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const typographyInventory = [
  { className: "text-xs", count: "250", role: "Small metadata and labels" },
  {
    className: "SIDEBAR_NAV_TEXT_CLASS",
    count: "app sidebar",
    role: "Sidebar nav labels at regular weight (text-sm font-normal)",
  },
  { className: "text-sm", count: "276", role: "Default interface body" },
  { className: "text-base", count: "6", role: "Inputs and larger body text" },
  { className: "text-[11px]", count: "33", role: "One-off compact labels" },
  { className: "text-[10px]", count: "18", role: "One-off micro labels" },
  { className: "font-medium", count: "144", role: "Emphasis" },
  { className: "tracking-tight", count: "12", role: "Headings" },
];

function useRuntimeTokens(tokenNames: string[]) {
  const theme = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const refreshKey = [
    theme.isLoading,
    theme.primaryColor,
    theme.resolvedTheme,
    theme.themeMode,
  ].join(":");

  useEffect(() => {
    void refreshKey;
    const styles = getComputedStyle(document.documentElement);
    setValues(
      Object.fromEntries(
        tokenNames.map((token) => [
          token,
          styles.getPropertyValue(token).trim(),
        ]),
      ),
    );
  }, [tokenNames, refreshKey]);

  return values;
}

function ThemeControls() {
  const { themeMode, setThemeMode, primaryColor, setPrimaryColor } = useTheme();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <Select
        value={themeMode}
        onValueChange={(value) => {
          setThemeMode(value as "system" | "light" | "dark");
        }}
      >
        <SelectTrigger className="w-56" size="sm" aria-label="Theme">
          <SelectValue placeholder="Theme" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System · Berd Default</SelectItem>
          <SelectItem value="light">Light · Berd Light</SelectItem>
          <SelectItem value="dark">Dark · Berd Dark</SelectItem>
        </SelectContent>
      </Select>

      <label
        className="relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-within:outline-none focus-within:ring-2 focus-within:ring-ring"
        htmlFor="design-system-primary-color"
      >
        <span
          aria-hidden="true"
          className="size-5 rounded-full"
          style={{ backgroundColor: primaryColor }}
        />
        <span>Primary color</span>
        <span className="sr-only">Primary color</span>
        <input
          aria-label="Primary color"
          className="absolute inset-0 cursor-pointer opacity-0"
          id="design-system-primary-color"
          onChange={(event) => setPrimaryColor(event.target.value)}
          type="color"
          value={primaryColor}
        />
      </label>
    </div>
  );
}

function PageIntro({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="font-display text-2xl font-normal tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function Surface({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-background px-4 py-4">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function ComponentSpec({ name }: { name: string }) {
  const item = componentInventory.find((component) => component.name === name);

  if (!item) return null;

  return (
    <Surface
      title="Generated inventory"
      description="Pulled from the generated component manifest so source, variants, slots, and tokens stay aligned with code."
    >
      <dl className="grid gap-3 text-sm md:grid-cols-3">
        <div className="min-w-0 rounded-md border border-border bg-card p-3">
          <dt className="text-xs font-medium text-muted-foreground">Source</dt>
          <dd className="mt-1 truncate font-mono text-xs text-foreground">
            {item.source}
          </dd>
        </div>
        <div className="min-w-0 rounded-md border border-border bg-card p-3">
          <dt className="text-xs font-medium text-muted-foreground">
            Variants
          </dt>
          <dd className="mt-1 text-foreground">
            {formatManifestVariants(item)}
          </dd>
        </div>
        <div className="min-w-0 rounded-md border border-border bg-card p-3">
          <dt className="text-xs font-medium text-muted-foreground">Slots</dt>
          <dd className="mt-1 text-foreground">{formatManifestSlots(item)}</dd>
        </div>
      </dl>
    </Surface>
  );
}

function tokenClassToCssVariable(className: string, utility: string) {
  const core = className.split(":").at(-1) ?? className;
  const match = new RegExp(`^${utility}-([a-z0-9-]+)(?:/.+)?$`).exec(core);

  return match ? `--${match[1]}` : undefined;
}

function getGenericComponentTokenDetails(name: string) {
  const item = getManifestItem(name);
  const tokenClasses = item?.tokenClasses ?? [];
  const backgroundTokens = tokenClasses
    .map((className) => tokenClassToCssVariable(className, "bg"))
    .filter(Boolean);
  const textTokens = tokenClasses
    .map((className) => tokenClassToCssVariable(className, "text"))
    .filter(Boolean);
  const borderTokens = tokenClasses
    .map((className) => tokenClassToCssVariable(className, "border"))
    .filter(Boolean);

  return {
    colorRows: [
      {
        anatomy: `${name} surface`,
        state: "Default",
        background: backgroundTokens[0],
        textIcon: textTokens[0],
        border: borderTokens[0],
      },
      {
        anatomy: `${name} surface`,
        state: "Additional tokens",
        background: backgroundTokens.slice(1, 3).join(", ") || undefined,
        textIcon: textTokens.slice(1, 3).join(", ") || undefined,
        border: borderTokens.slice(1, 3).join(", ") || undefined,
      },
    ],
    textRows: [
      {
        anatomy: "Primary content",
        size: "text-sm",
        weight: "font-normal",
      },
    ],
  };
}

const componentPreviewRenderers: Record<string, () => React.ReactNode> = {
  Accordion: () => (
    <Accordion
      type="single"
      collapsible
      defaultValue="overview"
      className="w-full max-w-md rounded-md border border-border bg-background px-4"
    >
      <AccordionItem value="overview">
        <AccordionTrigger>Component anatomy</AccordionTrigger>
        <AccordionContent>
          Trigger and content slots use shared focus, spacing, and state tokens.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
  "Alert Dialog": () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="primary" destructive>
          Delete project
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project?</AlertDialogTitle>
          <AlertDialogDescription>
            This preview shows the modal structure, description copy, and paired
            actions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  "Aspect Ratio": () => (
    <AspectRatio
      ratio={16 / 9}
      className="w-72 overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
        16:9 preview
      </div>
    </AspectRatio>
  ),
  Avatar: () => (
    <Avatar className="size-12">
      <AvatarFallback>MG</AvatarFallback>
    </Avatar>
  ),
  "Berd Loader": () => <BerdLoader size={70} />,
  "Berd Loader Inline": () => <BerdLoaderInline size={70} />,
  Breadcrumb: () => (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#">Projects</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbCurrentPage>Berd</BreadcrumbCurrentPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
  Calendar: () => (
    <div className="rounded-md border border-border bg-background">
      <Calendar mode="single" selected={new Date(2026, 4, 17)} />
    </div>
  ),
  Card: () => (
    <Card className="w-72">
      <CardHeader>
        <CardTitle>Project brief</CardTitle>
        <CardDescription>Design system component surface.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Card content keeps grouped information readable.
      </CardContent>
    </Card>
  ),
  Carousel: () => (
    <Carousel className="w-72">
      <CarouselContent>
        {["One", "Two", "Three"].map((label) => (
          <CarouselItem key={label}>
            <div className="flex h-28 items-center justify-center rounded-md border border-border bg-card text-sm text-muted-foreground">
              {label}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>
  ),
  "Chart Container": () => (
    <div className="grid h-36 w-72 grid-cols-6 items-end gap-2 rounded-md border border-border bg-card p-4">
      {[40, 70, 52, 88, 64, 96].map((height, index) => (
        <div
          key={height}
          className="rounded-t-sm bg-primary"
          style={{ height: `${height}%`, opacity: 0.45 + index * 0.08 }}
        />
      ))}
    </div>
  ),
  Checkbox: () => (
    <Label className="items-center">
      <Checkbox defaultChecked />
      Enable preview mode
    </Label>
  ),
  Collapsible: () => (
    <Collapsible
      defaultOpen
      className="w-72 rounded-md border border-border p-3"
    >
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          Toggle details
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 text-sm text-muted-foreground">
        Collapsible content keeps secondary information nearby.
      </CollapsibleContent>
    </Collapsible>
  ),
  Command: () => (
    <Command className="h-48 w-80 border border-border">
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandGroup heading="Actions">
          <CommandItem>
            Open command
            <CommandShortcut>⌘K</CommandShortcut>
          </CommandItem>
          <CommandItem>Create project</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
  "Confirm Dialog": () => (
    <Button type="button" variant="primary" destructive>
      Confirm action
    </Button>
  ),
  "Context Menu": () => (
    <div className="rounded-md border border-dashed border-border px-6 py-4 text-sm text-muted-foreground">
      Right-click target
    </div>
  ),
  "Contextual Tip": () => (
    <ContextualTip
      dismissLabel="Dismiss tip"
      actionLabel="Review"
      onAction={() => undefined}
      onDismiss={() => undefined}
    >
      Token coverage improved.
    </ContextualTip>
  ),
  "Detail Field": () => (
    <DetailField
      label="Provider"
      meta={<Badge variant="outline">Active</Badge>}
    >
      OpenAI
    </DetailField>
  ),
  Dialog: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Open dialog
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dialog preview</DialogTitle>
          <DialogDescription>
            A focused modal surface with title, description, content, and
            actions.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
          Dialog body content sits inside the shared modal shell.
        </div>
        <DialogFooter>
          <Button type="button" variant="outline">
            Cancel
          </Button>
          <Button type="button">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  Drawer: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button type="button" variant="outline">
          Open drawer
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Drawer preview</DrawerTitle>
          <DrawerDescription>
            Drawer content keeps related controls in a spatial side panel.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 text-sm text-muted-foreground">
          Drawer body content.
        </div>
        <DrawerFooter>
          <Button type="button">Continue</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
  "File Context Menu": () => (
    <div className="rounded-md border border-dashed border-border px-6 py-4 font-mono text-xs text-muted-foreground">
      /src/shared/ui/button.tsx
    </div>
  ),
  Form: () => (
    <FormItem className="w-72">
      <Label htmlFor="design-system-form-preview">Workspace name</Label>
      <Input id="design-system-form-preview" defaultValue="Berd" />
      <p className="text-sm text-muted-foreground">
        Helper text and validation share form slots.
      </p>
    </FormItem>
  ),
  "Berd Logo": () => <BerdLogo />,
  "Hover Card": () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button type="button" variant="outline">
          Hover card trigger
        </Button>
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="text-sm font-medium text-foreground">Hover card</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Supporting context appears without taking over the workflow.
        </p>
      </HoverCardContent>
    </HoverCard>
  ),
  "Image Lightbox": () => (
    <div className="flex size-32 items-center justify-center rounded-md border border-border bg-card text-sm text-muted-foreground">
      Image preview
    </div>
  ),
  "Input Group": () => (
    <InputGroup className="w-80">
      <InputGroupAddon>@</InputGroupAddon>
      <InputGroupInput defaultValue="Berd" />
    </InputGroup>
  ),
  "Input OTP": () => (
    <InputOTP maxLength={6} value="123">
      <InputOTPGroup>
        {otpPreviewSlots.map((slot, index) => (
          <InputOTPSlot key={slot} index={index} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  ),
  Input: () => <Input className="w-72" defaultValue="Design system" />,
  Label: () => (
    <Label htmlFor="design-system-label-preview">
      <Checkbox id="design-system-label-preview" />
      Label text
    </Label>
  ),
  "Main Panel Layout": () => (
    <div className="h-32 w-72 overflow-hidden rounded-md border border-border">
      <MainPanelLayout>
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Main panel
        </div>
      </MainPanelLayout>
    </div>
  ),
  Menubar: () => (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
      </MenubarMenu>
    </Menubar>
  ),
  "Navigation Menu": () => (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger>Products</NavigationMenuTrigger>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  ),
  "Page Columns": () => (
    <div className="grid w-80 grid-cols-[110px_1fr] gap-3 rounded-md border border-border p-3">
      <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
        Sidebar
      </div>
      <div className="rounded-md bg-card p-3 text-xs text-muted-foreground">
        Content
      </div>
    </div>
  ),
  "Detail Page Shell": () => (
    <PageHeader
      eyebrow={<Badge variant="outline">Detail</Badge>}
      title="Agent profile"
      description="Structured page header preview."
      variant="detail"
    />
  ),
  Pagination: () => (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#" isActive>
            1
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
  Popover: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline">
          Popover trigger
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <p className="text-sm font-medium text-foreground">Popover content</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Compact controls and contextual content live here.
        </p>
      </PopoverContent>
    </Popover>
  ),
  Progress: () => <Progress value={62} className="w-72" />,
  "Radio Group": () => (
    <div className="grid w-80 gap-5">
      <RadioGroup defaultValue="comfortable">
        <Label className="items-center">
          <RadioGroupItem value="compact" />
          Compact
        </Label>
        <Label className="items-center">
          <RadioGroupItem value="comfortable" />
          Comfortable
        </Label>
      </RadioGroup>
      <RadioGroup defaultValue="automatic" className="gap-2">
        <RadioGroupCard
          id="radio-card-automatic"
          value="automatic"
          label="Automatic"
          description="Choose behavior based on the current audio output."
        />
        <RadioGroupCard
          id="radio-card-prevent"
          value="prevent"
          label="Prevent feedback"
          description="Pause listening while audio is playing."
        />
      </RadioGroup>
    </div>
  ),
  "Resizable Handle": () => (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-28 w-80 rounded-md border border-border"
    >
      <ResizablePanel defaultSize={45}>
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Left
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={55}>
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Right
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
  "Scroll Area": () => (
    <ScrollArea className="h-32 w-72 rounded-md border border-border p-3">
      <div className="grid gap-2">
        {scrollAreaPreviewRows.map((row) => (
          <div key={row} className="text-sm text-muted-foreground">
            {row}
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
  "Searchable Select": () => (
    <SearchableSelect
      value="button"
      options={[
        { value: "button", label: "Button" },
        { value: "dialog", label: "Dialog" },
      ]}
      onValueChange={() => undefined}
    />
  ),
  "Search Bar": () => (
    <SearchBar
      value="buttons"
      onChange={() => undefined}
      placeholder="Search components"
      aria-label="Search components"
    />
  ),
  Separator: () => (
    <div className="w-72 space-y-3">
      <p className="text-sm text-foreground">Section one</p>
      <Separator />
      <p className="text-sm text-muted-foreground">Section two</p>
    </div>
  ),
  "Session Activity Indicator": () => (
    <div className="flex items-center gap-3">
      <SessionActivityIndicator isRunning />
      <SessionActivityIndicator hasUnread />
    </div>
  ),
  "Settings Page": () => (
    <div className="h-40 w-80 overflow-hidden rounded-md border border-border">
      <SettingsPage
        title="General"
        description="Shared settings page structure."
        actions={<Button size="xs">Save</Button>}
      >
        <div className="px-6 text-sm text-muted-foreground">Setting row</div>
      </SettingsPage>
    </div>
  ),
  "Settings Section": () => (
    <SettingsSections className="w-96">
      <SettingsSection title="Installed">
        <SettingsRow label="Calendar" action={<Button>Configure</Button>} />
      </SettingsSection>
      <SettingsSection title="Available">
        <SettingsRow label="Drive" action={<Button>Connect</Button>} />
      </SettingsSection>
    </SettingsSections>
  ),
  "Settings Row": () => (
    <div className="w-96 divide-y divide-border">
      <SettingsRow
        label="Show session cost"
        description="Display estimated running cost when available."
        action={<Switch defaultChecked aria-label="Show session cost" />}
      />
      <SettingsRow
        label="Keyboard shortcuts"
        action={<Button variant="outline">Customize</Button>}
      />
    </div>
  ),
  Sheet: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline">
          Open sheet
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Sheet preview</SheetTitle>
          <SheetDescription>
            A side panel for secondary workflows and detail editing.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 text-sm text-muted-foreground">
          Sheet body content.
        </div>
        <SheetFooter>
          <Button type="button">Done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  Sidebar: () => (
    <div className="h-40 w-56 rounded-md border border-border bg-background p-3">
      <div className="mb-3 h-6 w-6 rounded bg-muted" />
      <div className="space-y-2">
        <div className="h-7 rounded-md bg-sidebar-accent" />
        <div className="h-7 rounded-md bg-card" />
        <div className="h-7 rounded-md bg-card" />
      </div>
    </div>
  ),
  Skeleton: () => (
    <div className="w-72 space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
  Slider: () => <Slider defaultValue={[42]} max={100} className="w-72" />,
  Toaster: () => (
    <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground shadow-popover">
      Toast host
    </div>
  ),
  Spinner: () => <Spinner className="size-6" />,
  "Split Button": () => (
    <SplitButton
      actions={[
        { id: "run", label: "Run" },
        { id: "debug", label: "Debug" },
      ]}
      activeActionId="run"
      menuTriggerLabel="Choose action"
      onPrimaryClick={() => undefined}
      onActionSelect={() => undefined}
    />
  ),
  Switch: () => <Switch defaultChecked aria-label="Toggle preview" />,
  Table: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Button</TableCell>
          <TableCell>Ready</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  Textarea: () => (
    <Textarea className="w-72" defaultValue="Multi-line component preview." />
  ),
  Toggle: () => (
    <Toggle defaultPressed aria-label="Toggle preview">
      Preview
    </Toggle>
  ),
  Tooltip: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline">
          Tooltip trigger
        </Button>
      </TooltipTrigger>
      <TooltipContent>Helpful label</TooltipContent>
    </Tooltip>
  ),
};

function GenericComponentPreview({ name }: { name: string }) {
  const preview = componentPreviewRenderers[name]?.();

  if (preview) {
    return <div className="w-full max-w-md">{preview}</div>;
  }

  const item = getManifestItem(name);
  const slotCount = item?.slots.length ?? 0;
  const variantCount =
    item?.cva.reduce(
      (count, cva) => count + Object.keys(cva.variants).length,
      0,
    ) ?? 0;

  return (
    <div className="grid w-full max-w-sm gap-3 rounded-md border border-border bg-background p-4 text-left shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {item?.source ?? "Source pending"}
          </p>
        </div>
        <Badge variant="outline">Manifest</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border bg-card p-3">
          <p className="text-[11px] font-medium text-muted-foreground">Slots</p>
          <p className="mt-1 text-lg font-medium text-foreground">
            {slotCount}
          </p>
        </div>
        <div className="rounded-md border border-border bg-card p-3">
          <p className="text-[11px] font-medium text-muted-foreground">
            Variant groups
          </p>
          <p className="mt-1 text-lg font-medium text-foreground">
            {variantCount}
          </p>
        </div>
      </div>
    </div>
  );
}

function GenericComponentPage({ name }: { name: string }) {
  const tokenDetails = getGenericComponentTokenDetails(name);

  return (
    <>
      <PageIntro
        title={name}
        description={
          componentPageDescriptions[name] ??
          "A shared UI primitive documented from the generated component manifest."
        }
      />
      <ComponentSpec name={name} />

      <ComponentPlayground
        description="Preview uses the real shared UI primitive when it can be rendered safely in-page. Components that need app state or a portal-only interaction fall back to a manifest summary."
        preview={<GenericComponentPreview name={name} />}
        controls={[]}
        details={
          <ComponentTokenDetails
            colorRows={tokenDetails.colorRows}
            textRows={tokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function TokenGrid({
  tokens,
  kind = "color",
}: {
  tokens: Array<string | RuntimeToken>;
  kind?: "color" | "shape" | "spacing" | "elevation";
}) {
  const tokenItems = tokens.map((token) =>
    typeof token === "string" ? { name: token } : token,
  );
  const tokenNames = Array.from(new Set(tokenItems.map((token) => token.name)));
  const values = useRuntimeTokens(tokenNames);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {tokenItems.map((token) => (
        <div
          key={token.name}
          className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-card p-3"
        >
          <TokenPreview token={token.name} kind={kind} />
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-foreground">
              {token.name}
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {values[token.name] || "not set"}
            </p>
            {token.definition ? (
              <div className="mt-2 rounded-md border border-border bg-background px-2 py-1.5">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Defined as
                </p>
                <p className="mt-0.5 break-words font-mono text-[11px] text-foreground">
                  {token.definition}
                </p>
              </div>
            ) : null}
            {token.description ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {token.description}
              </p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function TokenNameWithSwatch({ token }: { token: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className="size-4 shrink-0 rounded border border-border"
        style={{ background: getTokenColorPaint(token) }}
      />
      <span className="truncate font-mono text-xs text-foreground">
        {token}
      </span>
    </div>
  );
}

function RuntimeTokenValue({ value }: { value?: string }) {
  return (
    <span className="block max-w-48 truncate font-mono text-[11px] text-muted-foreground">
      {value || "not set"}
    </span>
  );
}

function TokenPreview({
  token,
  kind,
}: {
  token: string;
  kind: "color" | "shape" | "spacing" | "elevation";
}) {
  if (kind === "elevation") {
    return (
      <span
        className="size-8 shrink-0 rounded-md border border-border bg-background"
        style={{ boxShadow: `var(${token})` }}
      />
    );
  }

  if (kind === "shape") {
    return (
      <span
        className="size-8 shrink-0 border border-border bg-secondary"
        style={{ borderRadius: `var(${token})` }}
      />
    );
  }

  if (kind === "spacing") {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <span
          className="block max-h-6 min-h-1 w-3 rounded-sm bg-primary"
          style={{ height: `min(var(${token}), 1.5rem)` }}
        />
      </span>
    );
  }

  return (
    <span
      className="size-8 shrink-0 rounded-md border border-border bg-background"
      style={{ background: getTokenColorPaint(token) }}
    />
  );
}

function getTokenColorPaint(token: string) {
  return `var(${token})`;
}

function OverviewPage() {
  return (
    <>
      <PageIntro
        title="Berd design system inventory"
        description="A small internal map of components, theme behavior, token values, and style drift. Component facts now come from a generated manifest."
      />
      <div className="grid gap-4 md:grid-cols-4">
        {[
          [
            String(designSystemComponentManifest.length),
            "UI component files",
            "Generated from src/shared/ui",
          ],
          [
            String(DESIGN_SYSTEM_COMPONENT_SECTIONS.length),
            "Used components",
            "Imported outside the explorer",
          ],
          [
            String(DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.length),
            "Not used",
            "No product imports found",
          ],
          [
            String(
              designSystemComponentManifest.reduce(
                (count, item) => count + item.cva.length,
                0,
              ),
            ),
            "CVA variant maps",
            "Parsed from class-variance-authority calls",
          ],
        ].map(([value, label, detail]) => (
          <div
            key={label}
            className="rounded-md border border-border bg-background px-4 py-4"
          >
            <p className="text-2xl font-medium tracking-tight text-foreground">
              {value}
            </p>
            <p className="mt-1 text-sm text-foreground">{label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
      <Surface
        title="Explorer component scope"
        description="These pages are still curated by humans, but their source, variants, and slots are generated from code."
      >
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Component</th>
                <th className="px-3 py-2 font-medium">Usage</th>
                <th className="px-3 py-2 font-medium">Variants</th>
                <th className="px-3 py-2 font-medium">Slots</th>
              </tr>
            </thead>
            <tbody>
              {componentInventory.map((item) => (
                <tr
                  key={item.name}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2 font-medium text-foreground">
                    {item.name}
                    <span className="mt-0.5 block font-mono text-[11px] font-normal text-muted-foreground">
                      {item.source}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        unusedComponentLabels.has(item.name)
                          ? "outline"
                          : "secondary"
                      }
                    >
                      {unusedComponentLabels.has(item.name)
                        ? "Not used"
                        : "Used"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatManifestVariants(item)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatManifestSlots(item)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>
    </>
  );
}

type ChromeButtonEntry = {
  manifestName: string;
  base: string;
  useWhen: string;
  surfaceClassName: string;
  surfaceLabel: string;
  preview: React.ReactNode;
};

const chromeButtonEntries: ChromeButtonEntry[] = [
  {
    manifestName: "Top Bar Icon Button",
    base: "ghost",
    useWhen: "Icon actions in the app top bar / window chrome.",
    surfaceClassName: "bg-card-glass",
    surfaceLabel: "top bar",
    preview: (
      <TopBarIconButton aria-label="Search">
        <Search aria-hidden="true" />
      </TopBarIconButton>
    ),
  },
  {
    manifestName: "Composer Action Button",
    base: "subtle",
    useWhen: "Controls on the chat composer surface.",
    surfaceClassName: "bg-surface-composer",
    surfaceLabel: "composer",
    preview: (
      <ComposerActionButton size="icon-pill-sm" aria-label="Attach">
        <Plus aria-hidden="true" />
      </ComposerActionButton>
    ),
  },
  {
    manifestName: "Page Header Button",
    base: "subtle",
    useWhen: "View-header actions rendered into the app top strip.",
    surfaceClassName: "bg-canvas-base",
    surfaceLabel: "canvas chrome",
    preview: <PageHeaderButton>Search chat</PageHeaderButton>,
  },
  {
    manifestName: "Agent Tile Button",
    base: "subtle",
    useWhen: "Actions floating over agent/persona tile artwork.",
    surfaceClassName: "bg-muted",
    surfaceLabel: "agent tile",
    preview: (
      <AgentTileButton size="icon-xs" aria-label="Open agent menu">
        <Plus aria-hidden="true" />
      </AgentTileButton>
    ),
  },
  {
    manifestName: "Glass Button",
    base: "subtle",
    useWhen: "Controls floating over media, canvases, or artwork.",
    surfaceClassName: "bg-muted",
    surfaceLabel: "media/canvas",
    preview: <GlassButton size="sm">Recenter</GlassButton>,
  },
  {
    manifestName: "Voice Conversation Button",
    base: "subtle",
    useWhen: "User or assistant controls in the floating voice surface.",
    surfaceClassName: "bg-card-glass",
    surfaceLabel: "voice conversation",
    preview: (
      <div className="flex items-center gap-2">
        <VoiceConversationButton
          type="button"
          speaking
          size="icon-sm"
          aria-label="Mute microphone while speech is detected"
        >
          <Mic aria-hidden="true" />
        </VoiceConversationButton>
        <VoiceConversationButton
          type="button"
          speaking
          disabled
          size="icon-sm"
          aria-label="Disabled speaking control"
        >
          <Mic aria-hidden="true" />
        </VoiceConversationButton>
      </div>
    ),
  },
  {
    manifestName: "Jump To Latest Button",
    base: "primary",
    useWhen: "Floating back-to-the-live-edge affordances over streams.",
    surfaceClassName: "bg-muted",
    surfaceLabel: "chat transcript",
    preview: <JumpToLatestButton size="sm">Jump to latest</JumpToLatestButton>,
  },
];

function ChromeButtonsShowcase() {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium text-foreground text-sm">Chrome buttons</h3>
        <p className="text-muted-foreground text-xs">
          Named wrappers that compose Button for specific app surfaces. Each
          recipe owns all of its interactive states; the base variant
          contributes role, geometry, and focus behavior. Full "when to use"
          docs live in each component's source and the generated manifest.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {chromeButtonEntries.map((entry) => {
          const item = getManifestItem(entry.manifestName);
          return (
            <div
              key={entry.manifestName}
              className="flex items-center gap-4 border-border border-b px-4 py-3 last:border-b-0"
            >
              <div className="w-56 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground text-xs">
                    {entry.manifestName.replaceAll(" ", "")}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    base: {entry.base}
                  </Badge>
                </div>
                {item ? (
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {item.source.replace("src/shared/ui/", "")}
                  </div>
                ) : null}
              </div>
              <div
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-md px-4 py-2.5",
                  entry.surfaceClassName,
                )}
                title={`Rendered on a mock ${entry.surfaceLabel} surface`}
              >
                {entry.preview}
              </div>
              <p className="min-w-0 text-muted-foreground text-xs">
                {entry.useWhen}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ButtonPage() {
  const [playgroundVariant, setPlaygroundVariant] =
    useState<ButtonVariant>("primary");
  const [playgroundSize, setPlaygroundSize] = useState<ButtonSize>("default");
  const [playgroundFeedbackState, setPlaygroundFeedbackState] =
    useState<ButtonFeedbackState>("idle");
  const [playgroundLoadingVisual, setPlaygroundLoadingVisual] =
    useState<ButtonLoadingVisual>("spinnerText");
  const [playgroundPreserveWidth, setPlaygroundPreserveWidth] = useState(true);
  const [playgroundLabel, setPlaygroundLabel] = useState("Button");
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const [playgroundDestructive, setPlaygroundDestructive] = useState(false);
  const [playgroundFlush, setPlaygroundFlush] = useState(false);
  const [playgroundLeftIcon, setPlaygroundLeftIcon] = useState(false);
  const [playgroundRightIcon, setPlaygroundRightIcon] = useState(false);
  const playgroundIsIconOnly = isIconButtonSize(playgroundSize);
  const playgroundTokenDetails = getButtonTokenDetails({
    variant: playgroundVariant,
    size: playgroundSize,
    destructive:
      playgroundDestructive && isButtonDestructiveEmphasis(playgroundVariant),
  });

  return (
    <>
      <PageIntro
        title="Button"
        description="Button variants and sizes running inside the real Berd app shell, with the active theme and primary color applied."
      />
      <ComponentSpec name="Button" />

      <ComponentPlayground
        description="Try the main Button props against the current theme and primary color."
        preview={
          <Button
            type="button"
            variant={playgroundVariant}
            size={playgroundSize}
            destructive={
              isButtonDestructiveEmphasis(playgroundVariant) &&
              playgroundDestructive
            }
            flush={playgroundVariant === "ghost" && playgroundFlush}
            feedbackState={playgroundFeedbackState}
            loadingLabel="Saving"
            successLabel="Saved"
            errorLabel="Try again"
            loadingVisual={playgroundLoadingVisual}
            preserveWidth={playgroundPreserveWidth}
            disabled={playgroundDisabled}
            aria-label={
              playgroundIsIconOnly ? playgroundLabel || "Button" : undefined
            }
            leftIcon={
              !playgroundIsIconOnly && playgroundLeftIcon ? (
                <Plus aria-hidden="true" />
              ) : undefined
            }
            rightIcon={
              !playgroundIsIconOnly && playgroundRightIcon ? (
                <Plus aria-hidden="true" />
              ) : undefined
            }
          >
            {playgroundIsIconOnly ? (
              <Plus aria-hidden="true" />
            ) : (
              playgroundLabel || "Button"
            )}
          </Button>
        }
        controls={[
          {
            id: "button-variant",
            label: "Variant",
            type: "select",
            value: playgroundVariant,
            options: buttonVariantOptions,
            onChange: (value) => setPlaygroundVariant(value as ButtonVariant),
          },
          {
            id: "button-size",
            label: "Size",
            type: "select",
            value: playgroundSize,
            options: buttonSizeOptions,
            onChange: (value) => setPlaygroundSize(value as ButtonSize),
          },
          ...(isButtonDestructiveEmphasis(playgroundVariant)
            ? [
                {
                  id: "button-destructive",
                  label: "Destructive",
                  type: "switch" as const,
                  checked: playgroundDestructive,
                  onChange: setPlaygroundDestructive,
                },
              ]
            : []),
          ...(playgroundVariant === "ghost"
            ? [
                {
                  id: "button-flush",
                  label: "Flush",
                  type: "switch" as const,
                  checked: playgroundFlush,
                  onChange: setPlaygroundFlush,
                },
              ]
            : []),
          {
            id: "button-feedback-state",
            label: "Feedback state",
            type: "select",
            value: playgroundFeedbackState,
            options: buttonFeedbackStateOptions,
            onChange: (value) =>
              setPlaygroundFeedbackState(value as ButtonFeedbackState),
          },
          ...(playgroundFeedbackState === "loading"
            ? [
                {
                  id: "button-loading-visual",
                  label: "Loading visual",
                  type: "select" as const,
                  value: playgroundLoadingVisual,
                  options: buttonLoadingVisualOptions,
                  onChange: (value: string) =>
                    setPlaygroundLoadingVisual(value as ButtonLoadingVisual),
                },
              ]
            : []),
          {
            id: "button-label",
            label: playgroundIsIconOnly ? "Accessible label" : "Label",
            type: "text",
            value: playgroundLabel,
            onChange: setPlaygroundLabel,
          },
          ...(!playgroundIsIconOnly
            ? [
                {
                  id: "button-left-icon",
                  label: "Left icon",
                  type: "switch" as const,
                  checked: playgroundLeftIcon,
                  onChange: setPlaygroundLeftIcon,
                },
                {
                  id: "button-right-icon",
                  label: "Right icon",
                  type: "switch" as const,
                  checked: playgroundRightIcon,
                  onChange: setPlaygroundRightIcon,
                },
              ]
            : []),
          {
            id: "button-preserve-width",
            label: "Preserve width",
            type: "switch",
            checked: playgroundPreserveWidth,
            onChange: setPlaygroundPreserveWidth,
          },
          {
            id: "button-disabled",
            label: "Disabled",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
      <ChromeButtonsShowcase />
    </>
  );
}

function ButtonGroupPage() {
  const [playgroundOrientation, setPlaygroundOrientation] =
    useState<ButtonGroupOrientation>("horizontal");
  const [playgroundValue, setPlaygroundValue] =
    useState<ButtonGroupPlaygroundValue>("two");
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const [playgroundShowText, setPlaygroundShowText] = useState(false);
  const playgroundTokenDetails = getButtonGroupTokenDetails({
    showText: playgroundShowText,
  });

  return (
    <>
      <PageIntro
        title="Button Group"
        description="Grouped buttons for adjacent actions and compact single-choice controls."
      />
      <ComponentSpec name="Button Group" />

      <ComponentPlayground
        description="This is the shadcn-studio Button Group component using Berd Button children."
        preview={
          <ButtonGroup
            orientation={playgroundOrientation}
            aria-label="Button group"
          >
            {playgroundShowText ? (
              <ButtonGroupText>Label</ButtonGroupText>
            ) : null}
            {buttonGroupPlaygroundOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={
                  playgroundValue === option.value ? "subtle" : "outline"
                }
                aria-pressed={playgroundValue === option.value}
                disabled={playgroundDisabled}
                onClick={() => setPlaygroundValue(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </ButtonGroup>
        }
        controls={[
          {
            id: "button-group-orientation",
            label: "Orientation",
            type: "select",
            value: playgroundOrientation,
            options: [
              { label: "horizontal", value: "horizontal" },
              { label: "vertical", value: "vertical" },
            ],
            onChange: (value) =>
              setPlaygroundOrientation(value as ButtonGroupOrientation),
          },
          {
            id: "button-group-value",
            label: "Selected value",
            type: "select",
            value: playgroundValue,
            options: buttonGroupPlaygroundOptions.map((option) => ({
              label: option.label,
              value: option.value,
            })),
            onChange: (value) =>
              setPlaygroundValue(value as ButtonGroupPlaygroundValue),
          },
          {
            id: "button-group-text",
            label: "Show label",
            type: "switch",
            checked: playgroundShowText,
            onChange: setPlaygroundShowText,
          },
          {
            id: "button-group-disabled",
            label: "Disable buttons",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function BerdLoaderPage() {
  const [playgroundAnimated, setPlaygroundAnimated] = useState(true);
  const [playgroundDecorative, setPlaygroundDecorative] = useState(true);
  const [playgroundSize, setPlaygroundSize] = useState("70");
  const [playgroundTone, setPlaygroundTone] = useState("foreground");
  const loaderSize = Number(playgroundSize);
  const tokenDetails = {
    colorRows: [
      {
        anatomy: "SVG mark",
        state: playgroundAnimated ? "Animated" : "Static",
        background: "none",
        textIcon: "currentColor",
        border: "none",
      },
      {
        anatomy: "Mask cutouts",
        state: playgroundAnimated ? "Looping" : "Settled",
        background: "none",
        textIcon: "transparent cut from currentColor",
        border: "none",
      },
      {
        anatomy: "Accessible wrapper",
        state: playgroundDecorative ? "Decorative" : "Labeled",
        background: "none",
        textIcon: playgroundDecorative ? "aria-hidden" : "aria-label: Loading",
        border: "none",
      },
    ],
    textRows: [
      {
        anatomy: "Loader",
        size: `${loaderSize}px`,
        weight: `loop ${BERD_LOADER_LOOP_MS}ms`,
      },
    ],
  };

  return (
    <>
      <PageIntro
        title="Berd Loader"
        description="Branded Berd activity mark for startup, active sessions, and agent work states."
      />
      <ComponentSpec name="Berd Loader" />

      <ComponentPlayground
        description="Inspect the inline SVG loader in its animated, reduced-motion, decorative, and labeled states. The mark inherits currentColor from its surrounding context."
        preview={
          <div
            className={cn(
              "flex min-h-32 w-full max-w-sm items-center justify-center rounded-md border border-border bg-card p-6",
              playgroundTone === "muted" && "text-muted-foreground",
              playgroundTone === "primary" && "text-primary",
              playgroundTone === "responding" &&
                "bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg",
            )}
          >
            <BerdLoader
              animated={playgroundAnimated}
              decorative={playgroundDecorative}
              size={loaderSize}
            />
          </div>
        }
        controls={[
          {
            id: "berd-loader-animated",
            label: "Animated",
            type: "switch",
            checked: playgroundAnimated,
            onChange: setPlaygroundAnimated,
          },
          {
            id: "berd-loader-decorative",
            label: "Decorative",
            type: "switch",
            checked: playgroundDecorative,
            onChange: setPlaygroundDecorative,
          },
          {
            id: "berd-loader-size",
            label: "Size",
            type: "select",
            value: playgroundSize,
            options: [
              { label: "14px · session row", value: "14" },
              { label: "70px · default", value: "70" },
              { label: "83px · startup", value: "83" },
            ],
            onChange: setPlaygroundSize,
          },
          {
            id: "berd-loader-tone",
            label: "Color context",
            type: "select",
            value: playgroundTone,
            options: [
              { label: "Foreground", value: "foreground" },
              { label: "Muted", value: "muted" },
              { label: "Primary", value: "primary" },
              { label: "Responding pill", value: "responding" },
            ],
            onChange: setPlaygroundTone,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={tokenDetails.colorRows}
            textRows={tokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function BerdLoaderInlinePage() {
  const [playgroundAnimated, setPlaygroundAnimated] = useState(true);
  const [playgroundDecorative, setPlaygroundDecorative] = useState(true);
  const [playgroundSize, setPlaygroundSize] = useState("14");
  const [playgroundTone, setPlaygroundTone] = useState("foreground");
  const loaderSize = Number(playgroundSize);
  const tokenDetails = {
    colorRows: [
      {
        anatomy: "SVG mark",
        state: playgroundAnimated ? "Animated" : "Static",
        background: "none",
        textIcon: "currentColor",
        border: "none",
      },
      {
        anatomy: "Mask cutouts",
        state: playgroundAnimated ? "Looping" : "Settled",
        background: "none",
        textIcon: "transparent cut from currentColor",
        border: "none",
      },
      {
        anatomy: "Accessible wrapper",
        state: playgroundDecorative ? "Decorative" : "Labeled",
        background: "none",
        textIcon: playgroundDecorative ? "aria-hidden" : "aria-label: Loading",
        border: "none",
      },
    ],
    textRows: [
      {
        anatomy: "Loader",
        size: `${loaderSize}px`,
        weight: `loop ${BERD_LOADER_INLINE_LOOP_MS}ms`,
      },
    ],
  };

  return (
    <>
      <PageIntro
        title="Berd Loader Inline"
        description="In-app activity mark for running sessions — left nav rows, the quick switcher, and the responding pill. A separate copy of Berd Loader so its animation can be tuned for small, repeated, in-app placements without changing the startup loader."
      />
      <ComponentSpec name="Berd Loader Inline" />

      <ComponentPlayground
        description="Inspect the in-app inline loader at the small sizes it actually renders in product. The mark inherits currentColor from its surrounding context."
        preview={
          <div
            className={cn(
              "flex min-h-32 w-full max-w-sm items-center justify-center rounded-md border border-border bg-card p-6",
              playgroundTone === "muted" && "text-muted-foreground",
              playgroundTone === "primary" && "text-primary",
              playgroundTone === "responding" &&
                "bg-surface-chat-responding-pill-bg text-surface-chat-responding-pill-fg",
            )}
          >
            <BerdLoaderInline
              animated={playgroundAnimated}
              decorative={playgroundDecorative}
              size={loaderSize}
            />
          </div>
        }
        controls={[
          {
            id: "berd-loader-inline-animated",
            label: "Animated",
            type: "switch",
            checked: playgroundAnimated,
            onChange: setPlaygroundAnimated,
          },
          {
            id: "berd-loader-inline-decorative",
            label: "Decorative",
            type: "switch",
            checked: playgroundDecorative,
            onChange: setPlaygroundDecorative,
          },
          {
            id: "berd-loader-inline-size",
            label: "Size",
            type: "select",
            value: playgroundSize,
            options: [
              { label: "14px · session row", value: "14" },
              { label: "16px · sidebar leading icon", value: "16" },
              { label: "70px · inspection", value: "70" },
            ],
            onChange: setPlaygroundSize,
          },
          {
            id: "berd-loader-inline-tone",
            label: "Color context",
            type: "select",
            value: playgroundTone,
            options: [
              { label: "Foreground", value: "foreground" },
              { label: "Muted", value: "muted" },
              { label: "Primary", value: "primary" },
              { label: "Responding pill", value: "responding" },
            ],
            onChange: setPlaygroundTone,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={tokenDetails.colorRows}
            textRows={tokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function BadgePage() {
  const [playgroundVariant, setPlaygroundVariant] =
    useState<BadgeVariant>("default");
  const [playgroundLabel, setPlaygroundLabel] = useState("Badge");
  const playgroundTokenDetails = getBadgeTokenDetails({
    variant: playgroundVariant,
  });

  return (
    <>
      <PageIntro
        title="Badge"
        description="Small semantic labels for status, grouping, and lightweight emphasis."
      />
      <ComponentSpec name="Badge" />

      <ComponentPlayground
        description="Try Badge variants against the current theme and primary color."
        preview={
          <Badge variant={playgroundVariant}>
            {playgroundLabel || "Badge"}
          </Badge>
        }
        controls={[
          {
            id: "badge-variant",
            label: "Variant",
            type: "select",
            value: playgroundVariant,
            options: badgeVariantOptions,
            onChange: (value) => setPlaygroundVariant(value as BadgeVariant),
          },
          {
            id: "badge-label",
            label: "Label",
            type: "text",
            value: playgroundLabel,
            onChange: setPlaygroundLabel,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function AlertPage() {
  const [playgroundVariant, setPlaygroundVariant] =
    useState<AlertVariant>("default");
  const [playgroundShowIcon, setPlaygroundShowIcon] = useState(true);
  const playgroundTokenDetails = getAlertTokenDetails({
    variant: playgroundVariant,
  });
  const AlertIcon =
    playgroundVariant === "destructive" ? IconAlertTriangle : IconSparkles;

  return (
    <>
      <PageIntro
        title="Alert"
        description="System messages that need durable structure, semantic tone, and theme-aware contrast."
      />
      <ComponentSpec name="Alert" />

      <ComponentPlayground
        description="Try Alert tone and icon structure against the current theme."
        preview={
          <Alert variant={playgroundVariant}>
            {playgroundShowIcon ? <AlertIcon /> : null}
            <AlertTitle>
              {playgroundVariant === "destructive"
                ? "Destructive alert"
                : "Default alert"}
            </AlertTitle>
            <AlertDescription>
              Alert description text shows the supporting message color.
            </AlertDescription>
          </Alert>
        }
        controls={[
          {
            id: "alert-variant",
            label: "Variant",
            type: "select",
            value: playgroundVariant,
            options: alertVariantOptions,
            onChange: (value) => setPlaygroundVariant(value as AlertVariant),
          },
          {
            id: "alert-icon",
            label: "Show icon",
            type: "switch",
            checked: playgroundShowIcon,
            onChange: setPlaygroundShowIcon,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function TabsPage() {
  const [playgroundVariant, setPlaygroundVariant] =
    useState<TabsVariant>("default");
  const [playgroundValue, setPlaygroundValue] = useState("one");
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const playgroundTokenDetails = getTabsTokenDetails({
    variant: playgroundVariant,
  });
  const playgroundOptions = [
    { value: "one", label: "Tab one" },
    { value: "two", label: "Tab two" },
    { value: "three", label: "Tab three" },
  ];

  return (
    <>
      <PageIntro
        title="Tabs"
        description="Section switching primitives that should preserve clear active state across themes."
      />
      <ComponentSpec name="Tabs" />

      <ComponentPlayground
        description="Try Tabs variants and active state against the current theme."
        preview={
          <Tabs value={playgroundValue} onValueChange={setPlaygroundValue}>
            <TabsList variant={playgroundVariant}>
              {playgroundOptions.map((option, index) => (
                <TabsTrigger
                  key={option.value}
                  value={option.value}
                  variant={playgroundVariant}
                  disabled={playgroundDisabled && index === 2}
                >
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {playgroundOptions.map((option) => (
              <TabsContent key={option.value} value={option.value} />
            ))}
          </Tabs>
        }
        controls={[
          {
            id: "tabs-variant",
            label: "Variant",
            type: "select",
            value: playgroundVariant,
            options: tabsVariantOptions,
            onChange: (value) => setPlaygroundVariant(value as TabsVariant),
          },
          {
            id: "tabs-value",
            label: "Active tab",
            type: "select",
            value: playgroundValue,
            options: playgroundOptions.map((option) => ({
              label: option.label,
              value: option.value,
            })),
            onChange: setPlaygroundValue,
          },
          {
            id: "tabs-disabled",
            label: "Disable last tab",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function ToggleGroupPage() {
  const [playgroundVariant, setPlaygroundVariant] =
    useState<ToggleGroupVariant>("default");
  const [playgroundSize, setPlaygroundSize] =
    useState<ToggleGroupSize>("default");
  const [playgroundType, setPlaygroundType] =
    useState<ToggleGroupSelectionType>("single");
  const [playgroundValue, setPlaygroundValue] = useState("preview");
  const [playgroundValues, setPlaygroundValues] = useState<string[]>([
    "preview",
    "tokens",
  ]);
  const [playgroundFirstLabel, setPlaygroundFirstLabel] = useState("Preview");
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const playgroundOptions = [
    { value: "preview", label: playgroundFirstLabel || "Preview" },
    { value: "code", label: "Code" },
    { value: "tokens", label: "Tokens" },
  ];
  const playgroundTokenDetails = getToggleGroupTokenDetails({
    variant: playgroundVariant,
    size: playgroundSize,
  });

  return (
    <>
      <PageIntro
        title="Toggle Group"
        description="Adjacent choice controls for short options with Radix keyboard behavior and Berd tokens."
      />
      <ComponentSpec name="Toggle Group" />

      <ComponentPlayground
        description="Try the ToggleGroup props against the current theme."
        preview={
          playgroundType === "single" ? (
            <ToggleGroup
              type="single"
              value={playgroundValue}
              onValueChange={(nextValue) =>
                nextValue && setPlaygroundValue(nextValue)
              }
              variant={playgroundVariant}
              size={playgroundSize}
              aria-label="Toggle group playground"
            >
              {playgroundOptions.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  disabled={playgroundDisabled}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <ToggleGroup
              type="multiple"
              value={playgroundValues}
              onValueChange={setPlaygroundValues}
              variant={playgroundVariant}
              size={playgroundSize}
              aria-label="Toggle group playground"
            >
              {playgroundOptions.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  disabled={playgroundDisabled}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )
        }
        controls={[
          {
            id: "toggle-group-variant",
            label: "Variant",
            type: "select",
            value: playgroundVariant,
            options: toggleGroupVariantOptions,
            onChange: (value) =>
              setPlaygroundVariant(value as ToggleGroupVariant),
          },
          {
            id: "toggle-group-size",
            label: "Size",
            type: "select",
            value: playgroundSize,
            options: toggleGroupSizeOptions,
            onChange: (value) => setPlaygroundSize(value as ToggleGroupSize),
          },
          {
            id: "toggle-group-type",
            label: "Selection type",
            type: "select",
            value: playgroundType,
            options: [
              { label: "single", value: "single" },
              { label: "multiple", value: "multiple" },
            ],
            onChange: (value) =>
              setPlaygroundType(value as ToggleGroupSelectionType),
          },
          {
            id: "toggle-group-value",
            label: "Primary value",
            type: "select",
            value:
              playgroundType === "single"
                ? playgroundValue
                : playgroundValues[0] || "preview",
            options: playgroundOptions.map((option) => ({
              label: option.label,
              value: option.value,
            })),
            onChange: (value) => {
              if (playgroundType === "single") {
                setPlaygroundValue(value);
                return;
              }
              setPlaygroundValues((currentValues) =>
                uniqueValues([value, ...currentValues.filter(Boolean)]),
              );
            },
          },
          {
            id: "toggle-group-first-label",
            label: "First label",
            type: "text",
            value: playgroundFirstLabel,
            onChange: setPlaygroundFirstLabel,
          },
          {
            id: "toggle-group-disabled",
            label: "Disable items",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function SelectPage() {
  const [playgroundSize, setPlaygroundSize] = useState<SelectSize>("default");
  const [playgroundValue, setPlaygroundValue] = useState("button");
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const playgroundTokenDetails = getSelectTokenDetails({
    disabled: playgroundDisabled,
    open: playgroundOpen,
  });

  return (
    <>
      <PageIntro
        title="Select"
        description="Single-value choice controls backed by Radix state and Berd overlay tokens."
      />
      <ComponentSpec name="Select" />

      <ComponentPlayground
        description="Try Select trigger sizing, disabled state, and open menu styling."
        preview={
          <Select
            value={playgroundValue}
            onValueChange={setPlaygroundValue}
            open={playgroundOpen}
            onOpenChange={setPlaygroundOpen}
          >
            <SelectTrigger
              className="w-44"
              size={playgroundSize}
              disabled={playgroundDisabled}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="button">Button</SelectItem>
              <SelectItem value="badge">Badge</SelectItem>
              <SelectItem value="alert">Alert</SelectItem>
            </SelectContent>
          </Select>
        }
        controls={[
          {
            id: "select-size",
            label: "Size",
            type: "select",
            value: playgroundSize,
            options: selectSizeOptions,
            onChange: (value) => setPlaygroundSize(value as SelectSize),
          },
          {
            id: "select-value",
            label: "Value",
            type: "select",
            value: playgroundValue,
            options: [
              { label: "Button", value: "button" },
              { label: "Badge", value: "badge" },
              { label: "Alert", value: "alert" },
            ],
            onChange: setPlaygroundValue,
          },
          {
            id: "select-open",
            label: "Show menu",
            type: "switch",
            checked: playgroundOpen,
            disabled: playgroundDisabled,
            onChange: setPlaygroundOpen,
          },
          {
            id: "select-disabled",
            label: "Disabled",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function DropdownMenuPage() {
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [playgroundItemVariant, setPlaygroundItemVariant] =
    useState<DropdownMenuItemVariant>("default");
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const playgroundTokenDetails = getDropdownMenuTokenDetails({
    itemVariant: playgroundItemVariant,
    open: playgroundOpen,
  });

  return (
    <>
      <PageIntro
        title="Dropdown Menu"
        description="Contextual command surfaces that exercise trigger state, portal rendering, and destructive menu item treatment."
      />
      <ComponentSpec name="Dropdown Menu" />

      <ComponentPlayground
        description="Try trigger and menu item states against the current theme."
        preview={
          <DropdownMenu
            open={playgroundOpen}
            onOpenChange={setPlaygroundOpen}
            modal={false}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                rightIcon={<IconChevronDown />}
                disabled={playgroundDisabled}
              >
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Menu label</DropdownMenuLabel>
              <DropdownMenuItem variant={playgroundItemVariant}>
                Menu item
              </DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                Destructive item
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        controls={[
          {
            id: "dropdown-open",
            label: "Show menu",
            type: "switch",
            checked: playgroundOpen,
            disabled: playgroundDisabled,
            onChange: setPlaygroundOpen,
          },
          {
            id: "dropdown-item-variant",
            label: "Item variant",
            type: "select",
            value: playgroundItemVariant,
            options: [
              { label: "default", value: "default" },
              { label: "destructive", value: "destructive" },
            ],
            onChange: (value) =>
              setPlaygroundItemVariant(value as DropdownMenuItemVariant),
          },
          {
            id: "dropdown-disabled",
            label: "Disable trigger",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function AccordionPage() {
  const [triggerStyle, setTriggerStyle] =
    useState<AccordionTriggerStyle>("default");
  const [behavior, setBehavior] = useState<AccordionBehavior>("single");
  const [allowCollapse, setAllowCollapse] = useState(true);
  const [disabledItem, setDisabledItem] = useState(false);
  const [indicatorPosition, setIndicatorPosition] =
    useState<AccordionIndicatorPosition>("end");
  const playgroundTokenDetails = getAccordionTokenDetails({
    triggerStyle,
    disabledItem,
  });

  const renderAccordionItems = () =>
    accordionItems.map((item, index) => (
      <AccordionItem
        key={item.value}
        value={item.value}
        disabled={disabledItem && index === 1}
      >
        {triggerStyle === "section" ? (
          <AccordionSectionTrigger title={item.title} meta={item.meta} />
        ) : (
          <AccordionTrigger indicatorPosition={indicatorPosition}>
            {item.title}
          </AccordionTrigger>
        )}
        <AccordionContent
          className={
            triggerStyle === "section"
              ? "px-5 text-muted-foreground"
              : undefined
          }
        >
          {item.content}
        </AccordionContent>
      </AccordionItem>
    ));

  return (
    <>
      <PageIntro
        title="Accordion"
        description="Disclosure stacks for progressive detail, with behavior, composition, and Radix state exposed in the playground."
      />
      <ComponentSpec name="Accordion" />

      <ComponentPlayground
        description="Control the real Accordion composition across open state, single or multiple behavior, disabled rows, and indicator placement."
        preview={
          behavior === "single" ? (
            <Accordion
              key={`single-${allowCollapse}`}
              type="single"
              collapsible={allowCollapse}
              defaultValue="first"
              className={cn(
                "w-full max-w-xl rounded-md border border-border bg-background",
                triggerStyle === "default" && "px-4",
              )}
            >
              {renderAccordionItems()}
            </Accordion>
          ) : (
            <Accordion
              key="multiple"
              type="multiple"
              defaultValue={["first"]}
              className={cn(
                "w-full max-w-xl rounded-md border border-border bg-background",
                triggerStyle === "default" && "px-4",
              )}
            >
              {renderAccordionItems()}
            </Accordion>
          )
        }
        controls={[
          {
            id: "accordion-trigger-style",
            label: "Trigger style",
            type: "select",
            value: triggerStyle,
            options: accordionTriggerStyleOptions,
            onChange: (value) =>
              setTriggerStyle(value as AccordionTriggerStyle),
          },
          {
            id: "accordion-behavior",
            label: "Behavior",
            type: "select",
            value: behavior,
            options: accordionBehaviorOptions,
            onChange: (value) => setBehavior(value as AccordionBehavior),
          },
          ...(behavior === "single"
            ? [
                {
                  id: "accordion-allow-collapse",
                  label: "Allow collapse",
                  type: "switch" as const,
                  checked: allowCollapse,
                  onChange: setAllowCollapse,
                },
              ]
            : []),
          {
            id: "accordion-disabled-item",
            label: "Disable second item",
            type: "switch",
            checked: disabledItem,
            onChange: setDisabledItem,
          },
          ...(triggerStyle === "default"
            ? [
                {
                  id: "accordion-indicator-position",
                  label: "Indicator position",
                  type: "select" as const,
                  value: indicatorPosition,
                  options: accordionIndicatorPositionOptions,
                  onChange: (value: string) =>
                    setIndicatorPosition(value as AccordionIndicatorPosition),
                },
              ]
            : []),
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function AlertDialogPage() {
  const [actionTone, setActionTone] =
    useState<AlertDialogActionTone>("destructive");
  const [descriptionLength, setDescriptionLength] =
    useState<AlertDialogDescriptionLength>("detailed");
  const [triggerDisabled, setTriggerDisabled] = useState(false);
  const playgroundTokenDetails = getAlertDialogTokenDetails({
    actionTone,
    triggerDisabled,
  });

  return (
    <>
      <PageIntro
        title="Alert Dialog"
        description="Blocking confirmation surfaces where modal structure, copy hierarchy, and action placement need to stay consistent."
      />
      <ComponentSpec name="Alert Dialog" />

      <ComponentPlayground
        description="Open the real modal from the trigger, then compare action tone, trigger state, and description length under wrapping pressure."
        preview={
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant={actionTone === "destructive" ? "primary" : "outline"}
                destructive={actionTone === "destructive"}
                disabled={triggerDisabled}
              >
                {alertDialogCopy.trigger}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{alertDialogCopy.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {getAlertDialogDescription(descriptionLength)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={
                    actionTone === "destructive"
                      ? buttonVariants({
                          variant: "primary",
                          destructive: true,
                        })
                      : undefined
                  }
                >
                  {alertDialogCopy.action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
        controls={[
          {
            id: "alert-dialog-action-tone",
            label: "Action tone",
            type: "select",
            value: actionTone,
            options: alertDialogActionToneOptions,
            onChange: (value) => setActionTone(value as AlertDialogActionTone),
          },
          {
            id: "alert-dialog-description-length",
            label: "Description",
            type: "select",
            value: descriptionLength,
            options: alertDialogDescriptionLengthOptions,
            onChange: (value) =>
              setDescriptionLength(value as AlertDialogDescriptionLength),
          },
          {
            id: "alert-dialog-trigger-disabled",
            label: "Disable trigger",
            type: "switch",
            checked: triggerDisabled,
            onChange: setTriggerDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function AspectRatioPage() {
  return <GenericComponentPage name="Aspect Ratio" />;
}

function AvatarPage() {
  return <GenericComponentPage name="Avatar" />;
}

function BreadcrumbPage() {
  const [treatment, setTreatment] = useState<BreadcrumbTreatment>("top-bar");
  const [depth, setDepth] = useState<BreadcrumbDepth>("detail");
  const [rootLabel, setRootLabel] = useState("Home");
  const [sectionLabel, setSectionLabel] = useState("Skills");
  const [currentLabel, setCurrentLabel] = useState("adapt");
  const showCurrent = depth !== "root";
  const tokenDetails = getBreadcrumbTokenDetails({
    depth,
    treatment,
    showCurrent,
  });

  const rootText = rootLabel.trim() || "Home";
  const sectionText = sectionLabel.trim() || "Skills";
  const currentText = currentLabel.trim() || "adapt";
  const isTopBar = treatment === "top-bar";
  const breadcrumbItems = [
    { id: "root", label: rootText, onClick: () => undefined },
    ...(depth === "section" ? [{ id: "section", label: sectionText }] : []),
    ...(depth === "detail"
      ? [
          { id: "section", label: sectionText, onClick: () => undefined },
          { id: "detail", label: currentText },
        ]
      : []),
  ];

  return (
    <>
      <PageIntro
        title="Breadcrumb"
        description={
          componentPageDescriptions.Breadcrumb ??
          "Hierarchy trails for wayfinding through nested pages and object detail surfaces."
        }
      />
      <ComponentSpec name="Breadcrumb" />

      <ComponentPlayground
        description="Preview uses the shared BreadcrumbTrail composition, including the top-bar tone, separator, and color-fade rules used by app chrome."
        preview={
          <BreadcrumbTrail
            items={breadcrumbItems}
            variant={isTopBar ? "top-bar" : "default"}
          />
        }
        controls={[
          {
            id: "breadcrumb-treatment",
            label: "Treatment",
            type: "select",
            value: treatment,
            options: [
              { label: "Top bar", value: "top-bar" },
              { label: "Default", value: "default" },
            ],
            onChange: (value) => setTreatment(value as BreadcrumbTreatment),
          },
          {
            id: "breadcrumb-depth",
            label: "Depth",
            type: "select",
            value: depth,
            options: [
              { label: "Root only", value: "root" },
              { label: "Section", value: "section" },
              { label: "Detail", value: "detail" },
            ],
            onChange: (value) => setDepth(value as BreadcrumbDepth),
          },
          {
            id: "breadcrumb-root-label",
            label: "Root label",
            type: "text",
            value: rootLabel,
            onChange: setRootLabel,
          },
          {
            id: "breadcrumb-section-label",
            label: "Section label",
            type: "text",
            value: sectionLabel,
            disabled: depth === "root",
            onChange: setSectionLabel,
          },
          {
            id: "breadcrumb-current-label",
            label: "Current label",
            type: "text",
            value: currentLabel,
            disabled: depth !== "detail",
            onChange: setCurrentLabel,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={tokenDetails.colorRows}
            textRows={tokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function CalendarPage() {
  return <GenericComponentPage name="Calendar" />;
}

function CardPage() {
  return <GenericComponentPage name="Card" />;
}

function CarouselPage() {
  return <GenericComponentPage name="Carousel" />;
}

function ChartContainerPage() {
  return <GenericComponentPage name="Chart Container" />;
}

function CheckboxPage() {
  return <GenericComponentPage name="Checkbox" />;
}

function CollapsiblePage() {
  return <GenericComponentPage name="Collapsible" />;
}

function CommandPage() {
  return <GenericComponentPage name="Command" />;
}

function ConfirmDialogPage() {
  return <GenericComponentPage name="Confirm Dialog" />;
}

function ContextMenuPage() {
  return <GenericComponentPage name="Context Menu" />;
}

function ContextualTipPage() {
  return <GenericComponentPage name="Contextual Tip" />;
}

function DetailFieldPage() {
  return <GenericComponentPage name="Detail Field" />;
}

function DialogPage() {
  return <GenericComponentPage name="Dialog" />;
}

function DrawerPage() {
  return <GenericComponentPage name="Drawer" />;
}

function FileContextMenuPage() {
  return <GenericComponentPage name="File Context Menu" />;
}

function FormPage() {
  return <GenericComponentPage name="Form" />;
}

function BerdLogoPage() {
  return <GenericComponentPage name="Berd Logo" />;
}

function HoverCardPage() {
  return <GenericComponentPage name="Hover Card" />;
}

function ImageLightboxPage() {
  return <GenericComponentPage name="Image Lightbox" />;
}

function InputGroupPage() {
  return <GenericComponentPage name="Input Group" />;
}

function InputOTPPage() {
  return <GenericComponentPage name="Input OTP" />;
}

function InputPage() {
  return <GenericComponentPage name="Input" />;
}

function LabelPage() {
  return <GenericComponentPage name="Label" />;
}

function MainPanelLayoutPage() {
  return <GenericComponentPage name="Main Panel Layout" />;
}

function MenubarPage() {
  return <GenericComponentPage name="Menubar" />;
}

function NavigationMenuPage() {
  return <GenericComponentPage name="Navigation Menu" />;
}

function PageColumnsPage() {
  return <GenericComponentPage name="Page Columns" />;
}

function DetailPageShellPage() {
  return <GenericComponentPage name="Detail Page Shell" />;
}

function PaginationPage() {
  return <GenericComponentPage name="Pagination" />;
}

function PopoverPage() {
  return <GenericComponentPage name="Popover" />;
}

function ProgressPage() {
  return <GenericComponentPage name="Progress" />;
}

function RadioGroupPage() {
  const [presentation, setPresentation] = useState<"item" | "card">("card");
  const [selected, setSelected] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const value = selected ? "option" : "";
  const stateLabel = `${selected ? "Selected" : "Unselected"}${
    disabled ? ", disabled" : ""
  }`;
  const colorRows: TokenColorRow[] =
    presentation === "card"
      ? [
          {
            anatomy: "Card surface",
            state: stateLabel,
            background: selected ? "muted" : "transparent",
            textIcon: disabled ? "foreground / 50% opacity" : "foreground",
            border: selected ? "primary" : "border",
          },
          ...(!disabled
            ? [
                {
                  anatomy: "Card surface",
                  state: "Focus visible",
                  background: selected ? "muted" : "transparent",
                  textIcon: "foreground",
                  border: "ring + ring / 50%",
                } satisfies TokenColorRow,
              ]
            : []),
          {
            anatomy: "Description",
            state: stateLabel,
            textIcon: disabled
              ? "muted-foreground / 50% opacity"
              : "muted-foreground",
          },
        ]
      : [
          {
            anatomy: "Radio control",
            state: stateLabel,
            background: selected ? "primary" : "transparent",
            textIcon: selected ? "background" : "none",
            border: selected ? "none" : "input",
          },
          ...(!disabled
            ? [
                {
                  anatomy: "Radio control",
                  state: "Focus visible",
                  background: selected ? "primary" : "transparent",
                  textIcon: selected ? "background" : "none",
                  border: "ring + ring / 50%",
                } satisfies TokenColorRow,
              ]
            : []),
        ];

  return (
    <>
      <PageIntro
        title="Radio Group"
        description="Choose between compact radio items and full-row selectable cards with shared selected, hover, focus-visible, and disabled semantics."
      />
      <ComponentSpec name="Radio Group" />
      <ComponentPlayground
        description="Switch presentation and state to inspect the exact anatomy and semantic tokens used by the shared primitive."
        preview={
          <RadioGroup
            value={value}
            onValueChange={(value) => setSelected(value === "option")}
            className="w-full max-w-sm"
          >
            {presentation === "card" ? (
              <RadioGroupCard
                id="radio-group-playground-option"
                value="option"
                label="Allow interruptions"
                description="Listen while Berd is speaking."
                disabled={disabled}
              />
            ) : (
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="radio-group-playground-option"
                  value="option"
                  disabled={disabled}
                />
                <Label htmlFor="radio-group-playground-option">Option</Label>
              </div>
            )}
          </RadioGroup>
        }
        controls={[
          {
            id: "radio-group-presentation",
            label: "Presentation",
            type: "select",
            value: presentation,
            options: [
              { label: "Card", value: "card" },
              { label: "Item", value: "item" },
            ],
            onChange: (value) => setPresentation(value as "item" | "card"),
          },
          {
            id: "radio-group-selected",
            label: "Selected",
            type: "switch",
            checked: selected,
            onChange: setSelected,
          },
          {
            id: "radio-group-disabled",
            label: "Disabled",
            type: "switch",
            checked: disabled,
            onChange: setDisabled,
          },
        ]}
        details={
          <ComponentTokenDetails
            colorRows={colorRows}
            textRows={[
              {
                anatomy: presentation === "card" ? "Card label" : "Item label",
                size: "text-sm",
                weight: presentation === "card" ? "font-medium" : "font-normal",
              },
              ...(presentation === "card"
                ? [
                    {
                      anatomy: "Card description",
                      size: "text-xs",
                      weight: "font-normal",
                    } satisfies TokenTextRow,
                  ]
                : []),
            ]}
          />
        }
      />
    </>
  );
}

function ResizableHandlePage() {
  return <GenericComponentPage name="Resizable Handle" />;
}

function ScrollAreaPage() {
  return <GenericComponentPage name="Scroll Area" />;
}

function SearchableSelectPage() {
  return <GenericComponentPage name="Searchable Select" />;
}

function SearchBarPage() {
  return <GenericComponentPage name="Search Bar" />;
}

function SeparatorPage() {
  return <GenericComponentPage name="Separator" />;
}

function SessionActivityIndicatorPage() {
  return <GenericComponentPage name="Session Activity Indicator" />;
}

function SettingsPagePage() {
  return <GenericComponentPage name="Settings Page" />;
}

function SettingsSectionPage() {
  return <GenericComponentPage name="Settings Section" />;
}

function SettingsRowPage() {
  return <GenericComponentPage name="Settings Row" />;
}

function SheetPage() {
  return <GenericComponentPage name="Sheet" />;
}

function SidebarPage() {
  return <GenericComponentPage name="Sidebar" />;
}

function SkeletonPage() {
  return <GenericComponentPage name="Skeleton" />;
}

function SliderPage() {
  return <GenericComponentPage name="Slider" />;
}

function ToasterPage() {
  return <GenericComponentPage name="Toaster" />;
}

function SpinnerPage() {
  return <GenericComponentPage name="Spinner" />;
}

function SplitButtonPage() {
  return <GenericComponentPage name="Split Button" />;
}

function SwitchPage() {
  const [playgroundChecked, setPlaygroundChecked] = useState(false);
  const [playgroundDisabled, setPlaygroundDisabled] = useState(false);
  const [playgroundLabel, setPlaygroundLabel] = useState("Label");
  const [playgroundLabelPosition, setPlaygroundLabelPosition] =
    useState<SwitchLabelPosition>("end");
  const playgroundTokenDetails = getSwitchTokenDetails({
    checked: playgroundChecked,
    disabled: playgroundDisabled,
    labelPosition: playgroundLabelPosition,
  });
  const switchId = "design-system-switch-preview";
  const switchLabel = playgroundLabel.trim() || "Switch";
  const switchControl = (
    <Switch
      id={switchId}
      checked={playgroundChecked}
      disabled={playgroundDisabled}
      onCheckedChange={setPlaygroundChecked}
      aria-label={playgroundLabelPosition === "none" ? switchLabel : undefined}
    />
  );
  const labelControl =
    playgroundLabelPosition === "none" ? null : (
      <Label
        htmlFor={switchId}
        className={cn(
          "text-sm font-medium text-foreground",
          playgroundDisabled && "opacity-50",
        )}
      >
        {switchLabel}
      </Label>
    );

  return (
    <>
      <PageIntro
        title="Switch"
        description="Binary setting control for immediate on/off preferences, with token details for track and thumb contrast."
      />
      <ComponentSpec name="Switch" />

      <ComponentPlayground
        description="Inspect checked, unchecked, disabled, and labeled states against the current theme."
        preview={
          <div className="flex min-w-56 items-center justify-center">
            <div className="flex items-center gap-3">
              {playgroundLabelPosition === "start" ? labelControl : null}
              {switchControl}
              {playgroundLabelPosition === "end" ? labelControl : null}
            </div>
          </div>
        }
        controls={[
          {
            id: "switch-disabled",
            label: "Disabled",
            type: "switch",
            checked: playgroundDisabled,
            onChange: setPlaygroundDisabled,
          },
          {
            id: "switch-label-position",
            label: "Label",
            type: "select",
            value: playgroundLabelPosition,
            options: switchLabelPositionOptions,
            onChange: (value) =>
              setPlaygroundLabelPosition(value as SwitchLabelPosition),
          },
          ...(playgroundLabelPosition !== "none"
            ? [
                {
                  id: "switch-label",
                  label: "Label text",
                  type: "text" as const,
                  value: playgroundLabel,
                  onChange: setPlaygroundLabel,
                },
              ]
            : []),
        ]}
        details={
          <ComponentTokenDetails
            colorRows={playgroundTokenDetails.colorRows}
            textRows={playgroundTokenDetails.textRows}
          />
        }
      />
    </>
  );
}

function TablePage() {
  return <GenericComponentPage name="Table" />;
}

function TextareaPage() {
  return <GenericComponentPage name="Textarea" />;
}

function TogglePage() {
  return <GenericComponentPage name="Toggle" />;
}

function TooltipPage() {
  return (
    <>
      <PageIntro
        title="Tooltip"
        description="Short hover or focus labels with shared surface styling and semantic interaction timing."
      />
      <ComponentSpec name="Tooltip" />

      <ComponentPlayground
        description="Tooltips give short, nonessential context for controls on hover or focus. Use them for concise labels or guidance, not critical instructions."
        preview={
          <div className="grid min-h-52 md:grid-cols-3 md:divide-x md:divide-border">
            <div className="flex items-center justify-center p-5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline">
                    Standard tooltip
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Appears after hover intent</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center justify-center border-t border-border p-5 md:border-t-0">
              <Tooltip delayDuration={TOOLTIP_DELAY.restedHover}>
                <TooltipTrigger asChild>
                  <Button type="button" variant="outline">
                    Rested hover
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Optional supporting information after deliberate hover
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center justify-center border-t border-border p-5 md:border-t-0">
              <div className="flex items-center gap-2">
                {[1, 2, 3].map((number) => (
                  <Tooltip key={number}>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="outline" size="icon-sm">
                        {number}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Tooltip {number}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          </div>
        }
        controls={[]}
        fullWidthPreview
        previewCaption={
          <div className="grid gap-3 md:grid-cols-3">
            <div className="px-2">
              <p className="text-xs font-medium text-foreground">
                Standard tooltip
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {TOOLTIP_DELAY.standard} ms gives users time to settle on a
                control before help appears.
              </p>
            </div>
            <div className="px-2">
              <p className="text-xs font-medium text-foreground">
                Rested hover
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {TOOLTIP_DELAY.restedHover.toLocaleString()} ms is for optional
                supporting information after deliberate hover, such as gestures,
                shortcuts, or truncated metadata.
              </p>
            </div>
            <div className="px-2">
              <p className="text-xs font-medium text-foreground">Skip delay</p>
              <p className="mt-1 text-xs text-muted-foreground">
                After one opens, move between buttons within{" "}
                {TOOLTIP_DELAY.skip} ms to skip the standard wait.
              </p>
            </div>
          </div>
        }
        details={
          <ComponentTokenDetails
            colorRows={[
              {
                anatomy: "Tooltip surface",
                state: "Default",
                background: "--popover-inverse",
                textIcon: "--popover-inverse-foreground",
                border: undefined,
              },
            ]}
            textRows={[
              {
                anatomy: "Tooltip label",
                size: "text-xs",
                weight: "font-normal",
              },
            ]}
            timingRows={[
              {
                token: "standard",
                value: `${TOOLTIP_DELAY.standard} ms`,
                use: "Standard product tooltip delay",
              },
              {
                token: "skip",
                value: `${TOOLTIP_DELAY.skip} ms`,
                use: "Immediate handoff between nearby tooltips",
              },
              {
                token: "restedHover",
                value: `${TOOLTIP_DELAY.restedHover.toLocaleString()} ms`,
                use: "Optional supporting information after deliberate hover, such as gestures, shortcuts, or truncated metadata",
              },
            ]}
          />
        }
      />
    </>
  );
}

type LiveColorTokenDeclaration = {
  scope: string;
  value: string;
};

type LiveColorTokenRow = {
  name: string;
  declarations: LiveColorTokenDeclaration[];
  dependencies: string[];
};

type LiveColorTokenTab = "app" | "raw" | "classes" | "all";

const liveColorTokenTabs = [
  { value: "app", label: "App tokens" },
  { value: "raw", label: "Raw colors" },
  { value: "classes", label: "Tailwind classes" },
  { value: "all", label: "All" },
] satisfies Array<{ value: LiveColorTokenTab; label: string }>;

function ColorPage() {
  const [activeTab, setActiveTab] = useState<LiveColorTokenTab>("app");
  const [searchQuery, setSearchQuery] = useState("");
  const [scanVersion, setScanVersion] = useState(0);
  const colorTokenRows = useMemo(() => {
    void scanVersion;
    return parseLiveColorTokens(globalsCssSource);
  }, [scanVersion]);
  const filteredRows = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const rowsForTab = colorTokenRows.filter((row) =>
      liveColorTokenMatchesTab(row, activeTab),
    );
    if (!normalizedQuery) return rowsForTab;

    return rowsForTab.filter((row) =>
      [
        row.name,
        ...row.dependencies,
        ...row.declarations.flatMap((declaration) => [
          declaration.scope,
          declaration.value,
        ]),
      ].some((term) => term.toLowerCase().includes(normalizedQuery)),
    );
  }, [activeTab, colorTokenRows, searchQuery]);

  return (
    <>
      <PageIntro
        title="Color tokens"
        description="Live from src/shared/styles/globals.css."
      />
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full md:w-80">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search color tokens"
            className="pl-9"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search tokens"
            type="search"
            value={searchQuery}
          />
        </div>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => setScanVersion((version) => version + 1)}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Refresh
        </Button>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as LiveColorTokenTab)}
      >
        <TabsList variant="buttons">
          {liveColorTokenTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} variant="buttons">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <LiveColorTokenTable rows={filteredRows} refreshKey={scanVersion} />
    </>
  );
}

function LiveColorTokenTable({
  rows,
  refreshKey,
}: {
  rows: LiveColorTokenRow[];
  refreshKey: number;
}) {
  const tokenNames = useMemo(() => rows.map((row) => row.name), [rows]);
  const values = useLiveRuntimeTokens(tokenNames, refreshKey);

  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[1180px] table-fixed text-left text-sm">
        <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-[280px] px-3 py-2 font-medium">Token</th>
            <th className="w-[220px] px-3 py-2 font-medium">Resolved</th>
            <th className="w-[470px] px-3 py-2 font-medium">Code</th>
            <th className="w-[210px] px-3 py-2 font-medium">Uses</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr
                key={row.name}
                className="border-b border-border last:border-0"
              >
                <td className="px-3 py-3 align-top">
                  <TokenNameWithSwatch token={row.name} />
                </td>
                <td className="px-3 py-3 align-top">
                  <RuntimeTokenValue value={values[row.name]} />
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="space-y-1">
                    {row.declarations.map((declaration) => (
                      <div
                        key={`${row.name}:${declaration.scope}:${declaration.value}`}
                        className="rounded-md border border-border bg-background px-2 py-1.5"
                      >
                        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                          {declaration.scope}
                        </span>
                        <span className="block overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-foreground">
                          {declaration.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  {row.dependencies.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {row.dependencies.map((dependency) => (
                        <span
                          key={dependency}
                          className="rounded-xs border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {dependency}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={4}
                className="px-3 py-8 text-center text-sm text-muted-foreground"
              >
                No tokens match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function liveColorTokenMatchesTab(
  row: LiveColorTokenRow,
  activeTab: LiveColorTokenTab,
) {
  if (activeTab === "all") return true;
  if (activeTab === "raw") {
    return row.declarations.some(
      (declaration) => declaration.scope === "@theme",
    );
  }
  if (activeTab === "classes") {
    return row.declarations.some(
      (declaration) => declaration.scope === "@theme inline",
    );
  }

  return row.declarations.some(
    (declaration) =>
      declaration.scope === ":root" || declaration.scope === "dark",
  );
}

function useLiveRuntimeTokens(tokenNames: string[], refreshKey: number) {
  const theme = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const tokenKey = tokenNames.join("|");
  const themeKey = [
    theme.isLoading,
    theme.primaryColor,
    theme.resolvedTheme,
    theme.themeMode,
  ].join(":");

  useEffect(() => {
    void tokenKey;
    void themeKey;
    void refreshKey;
    const styles = getComputedStyle(document.documentElement);
    setValues(
      Object.fromEntries(
        tokenNames.map((token) => [
          token,
          styles.getPropertyValue(token).trim(),
        ]),
      ),
    );
  }, [tokenKey, themeKey, refreshKey, tokenNames]);

  return values;
}

function parseLiveColorTokens(cssSource: string): LiveColorTokenRow[] {
  const declarationsByToken = new Map<string, LiveColorTokenDeclaration[]>();

  for (const block of getTopLevelCssBlocks(cssSource)) {
    const scope = getColorTokenScope(block.selector);
    if (!scope) continue;

    for (const declaration of getTopLevelCssDeclarations(block.body)) {
      if (!isColorTokenName(declaration.name)) continue;

      const declarations = declarationsByToken.get(declaration.name) ?? [];
      declarations.push({
        scope,
        value: declaration.value,
      });
      declarationsByToken.set(declaration.name, declarations);
    }
  }

  return Array.from(declarationsByToken.entries()).map(
    ([name, declarations]) => ({
      name,
      declarations,
      dependencies: Array.from(
        new Set(
          declarations.flatMap((declaration) =>
            Array.from(
              declaration.value.matchAll(/var\((--[a-z0-9-]+)/g),
              (match) => match[1],
            ),
          ),
        ),
      ),
    }),
  );
}

function getTopLevelCssBlocks(cssSource: string) {
  const blocks: Array<{ selector: string; body: string }> = [];
  let index = 0;

  while (index < cssSource.length) {
    const openIndex = cssSource.indexOf("{", index);
    if (openIndex === -1) break;

    const selector = cssSource.slice(index, openIndex).trim();
    let depth = 1;
    let cursor = openIndex + 1;

    while (cursor < cssSource.length && depth > 0) {
      const char = cssSource[cursor];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      cursor += 1;
    }

    blocks.push({
      selector,
      body: cssSource.slice(openIndex + 1, cursor - 1),
    });
    index = cursor;
  }

  return blocks;
}

function getTopLevelCssDeclarations(blockBody: string) {
  const declarations: Array<{ name: string; value: string }> = [];
  let depth = 0;
  let buffer = "";

  for (const char of blockBody) {
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    if (char === ";") {
      const match = buffer.match(/(--[a-z0-9-]+)\s*:\s*([\s\S]+)/);
      if (match) {
        declarations.push({
          name: match[1],
          value: match[2].replace(/\s+/g, " ").trim(),
        });
      }
      buffer = "";
      continue;
    }

    buffer += char;
  }

  return declarations;
}

function getColorTokenScope(selector: string) {
  const normalizedSelector = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  if (normalizedSelector.endsWith("@theme inline")) return "@theme inline";
  if (normalizedSelector.endsWith("@theme")) return "@theme";
  if (normalizedSelector.endsWith(":root")) return ":root";
  if (
    normalizedSelector.includes('[data-theme="dark"]') ||
    normalizedSelector.includes(".dark")
  ) {
    return "dark";
  }

  return null;
}

function isColorTokenName(token: string) {
  if (
    token.startsWith("--color-") ||
    token.startsWith("--app-top-bar-control-fg") ||
    token.startsWith("--surface-") ||
    token.startsWith("--canvas-") ||
    token.startsWith("--chip-") ||
    token.startsWith("--chart-") ||
    token.startsWith("--sidebar-") ||
    token.startsWith("--status") ||
    token.startsWith("--warning") ||
    token.startsWith("--clock") ||
    token.startsWith("--dark-")
  ) {
    return true;
  }

  if (
    [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--card-glass",
      "--popover",
      "--popover-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--destructive-foreground",
      "--input",
      "--ring",
      "--dot-color-base",
      "--project-tint",
      "--text-placeholder-composer",
      "--success",
      "--success-foreground",
      "--warning",
      "--warning-foreground",
      "--info",
      "--info-foreground",
    ].includes(token)
  ) {
    return true;
  }

  return false;
}

function ShapePage() {
  return (
    <>
      <PageIntro
        title="Shape and elevation"
        description="Runtime variables for radius and shadow depth. These change less than color, but they are the backbone for future vibe changes."
      />
      <Surface
        title="Shape"
        description="Radius tokens define the geometry of controls, cards, overlays, and modal surfaces."
      >
        <TokenGrid tokens={shapeTokens} kind="shape" />
      </Surface>
      <Surface
        title="Elevation"
        description="Shadow tokens describe depth for buttons, cards, popovers, modals, and focused controls."
      >
        <TokenGrid tokens={elevationTokens} kind="elevation" />
      </Surface>
    </>
  );
}

function SpacingPage() {
  return (
    <>
      <PageIntro
        title="Spacing"
        description="Runtime variables for app chrome spacing and control sizing."
      />
      <Surface
        title="Spacing"
        description="Spacing tokens currently cover app chrome and control dimensions."
      >
        <TokenGrid tokens={spacingTokens} kind="spacing" />
      </Surface>
      <Surface
        title="App chrome controls"
        description="Top bar controls use deep charcoal in light theme; inactive history controls use the disabled foreground token."
      >
        <TokenGrid tokens={appChromeColorTokens} kind="color" />
      </Surface>
    </>
  );
}

function TypographyPage() {
  return (
    <>
      <PageIntro
        title="Typography inventory"
        description="A first look at the current gap: lots of raw type utilities, not yet a named role scale."
      />
      <Surface title="Typography tokens">
        <TokenGrid tokens={typographyTokens} />
      </Surface>
      <Surface title="Observed type classes">
        <div className="grid gap-3 md:grid-cols-2">
          {typographyInventory.map((item) => (
            <div
              key={item.className}
              className="rounded-md border border-border bg-card p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-xs text-foreground">
                  {item.className}
                </p>
                <Badge variant="outline">{item.count} uses</Badge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{item.role}</p>
            </div>
          ))}
        </div>
      </Surface>
      <Surface title="Role preview">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Future body role
          </p>
          <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
            The inventory should help migrate raw utilities into roles like
            heading, body, label, metadata, and code.
          </p>
        </div>
      </Surface>
    </>
  );
}

function AuditPage() {
  return (
    <>
      <PageIntro
        title="Usage audit"
        description="A first snapshot of the drift patterns we saw in code search. The next step is to generate this from a manifest."
      />
      <Surface title="High-signal findings">
        <div className="grid gap-3">
          {[
            [
              "Raw type utilities dominate",
              "text-sm and text-xs are doing most typography work. This makes global type changes hard to reason about.",
            ],
            [
              "One-off sizes are common",
              "Classes like text-[11px], text-[10px], and rounded-[14px] should become named roles or tokens if intentional.",
            ],
            [
              "Theme responsiveness needs auditing",
              "Hardcoded colors and direct hex values are the first places to inspect across themes.",
            ],
          ].map(([title, description]) => (
            <div
              key={title}
              className="rounded-md border border-border bg-card p-3"
            >
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </Surface>
    </>
  );
}

function renderSection(section: DesignSystemSection) {
  switch (section) {
    case "overview":
      return <OverviewPage />;
    case "conversation-anatomy":
      return <ConversationAnatomyPage />;
    case "component-accordion":
      return <AccordionPage />;
    case "component-alert-dialog":
      return <AlertDialogPage />;
    case "component-aspect-ratio":
      return <AspectRatioPage />;
    case "component-avatar":
      return <AvatarPage />;
    case "component-button":
      return <ButtonPage />;
    case "component-button-group":
      return <ButtonGroupPage />;
    case "component-badge":
      return <BadgePage />;
    case "component-berd-loader":
      return <BerdLoaderPage />;
    case "component-berd-loader-inline":
      return <BerdLoaderInlinePage />;
    case "component-breadcrumb":
      return <BreadcrumbPage />;
    case "component-alert":
      return <AlertPage />;
    case "component-calendar":
      return <CalendarPage />;
    case "component-card":
      return <CardPage />;
    case "component-carousel":
      return <CarouselPage />;
    case "component-chart-container":
      return <ChartContainerPage />;
    case "component-checkbox":
      return <CheckboxPage />;
    case "component-collapsible":
      return <CollapsiblePage />;
    case "component-command":
      return <CommandPage />;
    case "component-confirm-dialog":
      return <ConfirmDialogPage />;
    case "component-context-menu":
      return <ContextMenuPage />;
    case "component-contextual-tip":
      return <ContextualTipPage />;
    case "component-detail-field":
      return <DetailFieldPage />;
    case "component-dialog":
      return <DialogPage />;
    case "component-drawer":
      return <DrawerPage />;
    case "component-tabs":
      return <TabsPage />;
    case "component-toggle-group":
      return <ToggleGroupPage />;
    case "component-select":
      return <SelectPage />;
    case "component-dropdown-menu":
      return <DropdownMenuPage />;
    case "component-file-context-menu":
      return <FileContextMenuPage />;
    case "component-form":
      return <FormPage />;
    case "component-berd-logo":
      return <BerdLogoPage />;
    case "component-hover-card":
      return <HoverCardPage />;
    case "component-image-lightbox":
      return <ImageLightboxPage />;
    case "component-input-group":
      return <InputGroupPage />;
    case "component-input-otp":
      return <InputOTPPage />;
    case "component-input":
      return <InputPage />;
    case "component-label":
      return <LabelPage />;
    case "component-main-panel-layout":
      return <MainPanelLayoutPage />;
    case "component-menubar":
      return <MenubarPage />;
    case "component-navigation-menu":
      return <NavigationMenuPage />;
    case "component-page-columns":
      return <PageColumnsPage />;
    case "component-detail-page-shell":
      return <DetailPageShellPage />;
    case "component-pagination":
      return <PaginationPage />;
    case "component-popover":
      return <PopoverPage />;
    case "component-progress":
      return <ProgressPage />;
    case "component-radio-group":
      return <RadioGroupPage />;
    case "component-resizable-handle":
      return <ResizableHandlePage />;
    case "component-scroll-area":
      return <ScrollAreaPage />;
    case "component-searchable-select":
      return <SearchableSelectPage />;
    case "component-search-bar":
      return <SearchBarPage />;
    case "component-separator":
      return <SeparatorPage />;
    case "component-session-activity-indicator":
      return <SessionActivityIndicatorPage />;
    case "component-settings-page":
      return <SettingsPagePage />;
    case "component-settings-section":
      return <SettingsSectionPage />;
    case "component-settings-row":
      return <SettingsRowPage />;
    case "component-sheet":
      return <SheetPage />;
    case "component-sidebar":
      return <SidebarPage />;
    case "component-skeleton":
      return <SkeletonPage />;
    case "component-slider":
      return <SliderPage />;
    case "component-toaster":
      return <ToasterPage />;
    case "component-spinner":
      return <SpinnerPage />;
    case "component-split-button":
      return <SplitButtonPage />;
    case "component-switch":
      return <SwitchPage />;
    case "component-table":
      return <TablePage />;
    case "component-textarea":
      return <TextareaPage />;
    case "component-toggle":
      return <TogglePage />;
    case "component-tooltip":
      return <TooltipPage />;
    case "color":
      return <ColorPage />;
    case "shape":
      return <ShapePage />;
    case "spacing":
      return <SpacingPage />;
    case "typography":
      return <TypographyPage />;
    case "audit":
      return <AuditPage />;
  }
}

function DesignSystemRailItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 w-full items-center rounded-sm px-3 text-left text-sm transition-colors duration-150",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function DesignSystemRailHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

export function DesignSystemView({
  activeSection,
  inspectorVisible = false,
  onClose,
  onInspectorVisibleChange,
  onSectionChange,
}: {
  activeSection: DesignSystemSection;
  inspectorVisible?: boolean;
  onClose?: () => void;
  onInspectorVisibleChange?: (visible: boolean) => void;
  onSectionChange?: (section: DesignSystemSection) => void;
}) {
  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      // Let open dialogs/popovers consume Escape first.
      if (target?.closest("[role='dialog'], [data-state='open']")) return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <MainPanelLayout backgroundColor="bg-canvas-base">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border">
          <div className="flex items-center gap-2 px-3 pb-2 pt-4">
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close design system"
                tooltip="Close design system"
                onClick={onClose}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
            <span className="text-sm font-medium text-foreground">
              Design system
            </span>
          </div>
          <nav
            aria-label="Design system navigation"
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 scrollbar-none"
          >
            <div className="space-y-0.5">
              {onInspectorVisibleChange ? (
                <div className="flex h-7 w-full items-center justify-between rounded-sm px-3 text-sm text-muted-foreground">
                  <span>Inspector</span>
                  <Switch
                    checked={inspectorVisible}
                    onCheckedChange={onInspectorVisibleChange}
                    aria-label="Show inspector"
                  />
                </div>
              ) : null}
              {DESIGN_SYSTEM_CORE_SECTIONS.map((item) => (
                <DesignSystemRailItem
                  key={item.id}
                  label={item.label}
                  active={activeSection === item.id}
                  onClick={() => onSectionChange?.(item.id)}
                />
              ))}
              <DesignSystemRailHeading>Components</DesignSystemRailHeading>
              {DESIGN_SYSTEM_COMPONENT_SECTIONS.map((item) => (
                <DesignSystemRailItem
                  key={item.id}
                  label={item.label}
                  active={activeSection === item.id}
                  onClick={() => onSectionChange?.(item.id)}
                />
              ))}
              <DesignSystemRailHeading>Not used</DesignSystemRailHeading>
              {DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.map((item) => (
                <DesignSystemRailItem
                  key={item.id}
                  label={item.label}
                  active={activeSection === item.id}
                  onClick={() => onSectionChange?.(item.id)}
                />
              ))}
            </div>
          </nav>
        </aside>
        <div className="min-w-0 flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6 page-transition">
            <ThemeControls />
            {renderSection(activeSection)}
          </div>
        </div>
      </div>
    </MainPanelLayout>
  );
}
