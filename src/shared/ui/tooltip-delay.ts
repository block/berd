export const TOOLTIP_DELAY = {
  /** Standard product tooltip delay. */
  standard: 500,
  /** Window where moving between nearby tooltip triggers opens immediately. */
  skip: 300,
  /** Optional supporting information that should appear only after deliberate hover. */
  restedHover: 1_000,
} as const;
