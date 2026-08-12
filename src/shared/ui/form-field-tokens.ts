/**
 * Shared className for form-field surfaces (text inputs, select triggers,
 * textareas) inside rails and detail forms — agent builder, automation
 * details, automation draft. Keeps form fields visually consistent across
 * these surfaces.
 *
 * The `bg-card/40` opacity gives a subtle differentiation from the
 * surrounding card surface without competing with it. Combine via `cn(...)`
 * when the field needs additional sizing classes (e.g. `min-h-32 resize-y`
 * for a textarea).
 */
export const FORM_FIELD_CLASS = "rounded-sm border-transparent bg-card/40";
