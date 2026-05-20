export type DesignSystemSection =
  | "overview"
  | "color"
  | "shape"
  | "spacing"
  | "typography"
  | "audit"
  | "component-accordion"
  | "component-alert-dialog"
  | "component-button"
  | "component-button-group"
  | "component-aspect-ratio"
  | "component-avatar"
  | "component-badge"
  | "component-breadcrumb"
  | "component-alert"
  | "component-calendar"
  | "component-card"
  | "component-carousel"
  | "component-chart-container"
  | "component-checkbox"
  | "component-collapsible"
  | "component-command"
  | "component-confirm-dialog"
  | "component-context-menu"
  | "component-contextual-tip"
  | "component-detail-field"
  | "component-dialog"
  | "component-drawer"
  | "component-tabs"
  | "component-toggle-group"
  | "component-select"
  | "component-dropdown-menu"
  | "component-file-context-menu"
  | "component-form"
  | "component-goose-logo"
  | "component-hover-card"
  | "component-image-lightbox"
  | "component-input-group"
  | "component-input-otp"
  | "component-input"
  | "component-label"
  | "component-main-panel-layout"
  | "component-menubar"
  | "component-navigation-menu"
  | "component-page-columns"
  | "component-detail-page-shell"
  | "component-pagination"
  | "component-popover"
  | "component-progress"
  | "component-radio-group"
  | "component-resizable-handle"
  | "component-scroll-area"
  | "component-searchable-select"
  | "component-search-bar"
  | "component-separator"
  | "component-session-activity-indicator"
  | "component-settings-page"
  | "component-sheet"
  | "component-sidebar"
  | "component-skeleton"
  | "component-slider"
  | "component-toaster"
  | "component-spinner"
  | "component-split-button"
  | "component-switch"
  | "component-table"
  | "component-textarea"
  | "component-toggle"
  | "component-tooltip";

export const DEFAULT_DESIGN_SYSTEM_SECTION: DesignSystemSection = "overview";

export const DESIGN_SYSTEM_CORE_SECTIONS: Array<{
  id: DesignSystemSection;
  label: string;
}> = [
  { id: "overview", label: "Overview" },
  { id: "color", label: "Color" },
  { id: "shape", label: "Shape" },
  { id: "spacing", label: "Spacing" },
  { id: "typography", label: "Typography" },
  { id: "audit", label: "Usage Audit" },
];

export const DESIGN_SYSTEM_COMPONENT_SECTIONS: Array<{
  id: DesignSystemSection;
  label: string;
}> = [
  { id: "component-alert", label: "Alert" },
  { id: "component-alert-dialog", label: "Alert Dialog" },
  { id: "component-avatar", label: "Avatar" },
  { id: "component-button", label: "Button" },
  { id: "component-button-group", label: "Button Group" },
  { id: "component-badge", label: "Badge" },
  { id: "component-checkbox", label: "Checkbox" },
  { id: "component-confirm-dialog", label: "Confirm Dialog" },
  { id: "component-contextual-tip", label: "Contextual Tip" },
  { id: "component-detail-field", label: "Detail Field" },
  { id: "component-dialog", label: "Dialog" },
  { id: "component-tabs", label: "Tabs" },
  { id: "component-select", label: "Select" },
  {
    id: "component-dropdown-menu",
    label: "Dropdown Menu",
  },
  { id: "component-context-menu", label: "Context Menu" },
  { id: "component-file-context-menu", label: "File Context Menu" },
  { id: "component-image-lightbox", label: "Image Lightbox" },
  { id: "component-input", label: "Input" },
  { id: "component-label", label: "Label" },
  { id: "component-page-columns", label: "Page Columns" },
  { id: "component-detail-page-shell", label: "Detail Page Shell" },
  { id: "component-popover", label: "Popover" },
  { id: "component-progress", label: "Progress" },
  { id: "component-scroll-area", label: "Scroll Area" },
  { id: "component-searchable-select", label: "Searchable Select" },
  { id: "component-search-bar", label: "Search Bar" },
  { id: "component-separator", label: "Separator" },
  {
    id: "component-session-activity-indicator",
    label: "Session Activity Indicator",
  },
  { id: "component-settings-page", label: "Settings Page" },
  { id: "component-skeleton", label: "Skeleton" },
  { id: "component-slider", label: "Slider" },
  { id: "component-toaster", label: "Toaster" },
  { id: "component-spinner", label: "Spinner" },
  { id: "component-split-button", label: "Split Button" },
  { id: "component-switch", label: "Switch" },
  { id: "component-textarea", label: "Textarea" },
  { id: "component-tooltip", label: "Tooltip" },
];

export const DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS: Array<{
  id: DesignSystemSection;
  label: string;
}> = [
  { id: "component-aspect-ratio", label: "Aspect Ratio" },
  { id: "component-accordion", label: "Accordion" },
  { id: "component-breadcrumb", label: "Breadcrumb" },
  { id: "component-calendar", label: "Calendar" },
  { id: "component-card", label: "Card" },
  { id: "component-carousel", label: "Carousel" },
  { id: "component-chart-container", label: "Chart Container" },
  { id: "component-collapsible", label: "Collapsible" },
  { id: "component-command", label: "Command" },
  { id: "component-drawer", label: "Drawer" },
  { id: "component-toggle-group", label: "Toggle Group" },
  { id: "component-form", label: "Form" },
  { id: "component-goose-logo", label: "Goose Logo" },
  { id: "component-hover-card", label: "Hover Card" },
  { id: "component-input-group", label: "Input Group" },
  { id: "component-input-otp", label: "Input OTP" },
  { id: "component-main-panel-layout", label: "Main Panel Layout" },
  { id: "component-menubar", label: "Menubar" },
  { id: "component-navigation-menu", label: "Navigation Menu" },
  { id: "component-pagination", label: "Pagination" },
  { id: "component-radio-group", label: "Radio Group" },
  { id: "component-resizable-handle", label: "Resizable Handle" },
  { id: "component-sheet", label: "Sheet" },
  { id: "component-sidebar", label: "Sidebar" },
  { id: "component-table", label: "Table" },
  { id: "component-toggle", label: "Toggle" },
];

export const DESIGN_SYSTEM_ALL_COMPONENT_SECTIONS = [
  ...DESIGN_SYSTEM_COMPONENT_SECTIONS,
  ...DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS,
];

export const DESIGN_SYSTEM_SECTIONS = [
  ...DESIGN_SYSTEM_CORE_SECTIONS,
  ...DESIGN_SYSTEM_ALL_COMPONENT_SECTIONS,
];
