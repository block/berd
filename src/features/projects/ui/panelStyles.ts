/* Shared styling recipes for the create/edit project panel's form anatomy,
   used by CreateProjectDialog and the pickers composed into it. */

/* Eyebrow labels above the panel's fields. Rested at a foreground tint rather
   than muted-foreground because the tinted glass surface eats too much of the
   muted gray's contrast, especially in dark mode. */
export const panelLabelClass =
  "text-xs font-normal text-foreground/80 transition-colors group-hover/field:text-foreground group-focus-within/field:text-foreground";
