const FIELD_BOUNDS = [
  [0, 59],
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

function resolveValue(value: string, fieldIndex: number): number | null {
  const upperValue = value.toUpperCase();
  const resolved =
    fieldIndex === 4
      ? MONTH_NAMES[upperValue]
      : fieldIndex === 5
        ? WEEKDAY_NAMES[upperValue]
        : undefined;
  if (resolved !== undefined) return resolved;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isFullWildcard(field: string): boolean {
  // Goose only marks a literal `*` as wildcard for day-of-month/weekday
  // matching; `*/1` is parsed as all values but still combined with AND.
  return field === "*";
}

function isValidCronField(field: string, fieldIndex: number): boolean {
  const [minimum, maximum] = FIELD_BOUNDS[fieldIndex];
  if (field.length === 0) return false;
  const items = field.split(",");

  for (const item of items) {
    if (!item) return false;

    const steppedParts = item.split("/");
    if (steppedParts.length > 2) return false;
    const [base, stepText] = steppedParts;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return false;
      const step = Number(stepText);
      if (
        !Number.isSafeInteger(step) ||
        step < 1 ||
        step > maximum - minimum + 1
      ) {
        return false;
      }
    }

    if (base === "*") {
      if (items.length !== 1) return false;
      continue;
    }

    const rangeParts = base.split("-");
    if (rangeParts.length > 2) return false;
    const start = resolveValue(rangeParts[0], fieldIndex);
    const end =
      rangeParts.length === 2 ? resolveValue(rangeParts[1], fieldIndex) : start;
    if (
      start === null ||
      end === null ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Checks Berd's deliberately conservative editable cron subset before calling
 * the pinned Goose scheduler, whose update path removes the old timer before
 * parsing the replacement. Existing expressions outside this subset remain
 * visible and can still be saved unchanged. The selected ruleset also excludes
 * expressions whose recurrence semantics are ambiguous or infrequent.
 */
export function validateLocalScheduleCron(cron: string): string | null {
  if ([...cron].some((character) => character.charCodeAt(0) > 127)) {
    return "unsupported";
  }
  const trimmedCron = cron.trim();
  if (!trimmedCron) return "unsupported";
  const fields = trimmedCron.split(/[ \t\r\n\v\f]+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return "fieldCount";
  }

  // Names are interpreted only by their owning field, never across the
  // expression; validate the same text that will be sent to Goose.
  const fieldsWithSeconds = fields.length === 5 ? ["0", ...fields] : fields;

  if (
    !fieldsWithSeconds.every((field, index) => isValidCronField(field, index))
  ) {
    return "unsupported";
  }

  // Keep edits to frequent, unambiguous recurrences: no month restriction,
  // and no simultaneous day-of-month + weekday restriction (Goose combines
  // those with AND).
  if (
    !isFullWildcard(fieldsWithSeconds[4]) ||
    (!isFullWildcard(fieldsWithSeconds[3]) &&
      !isFullWildcard(fieldsWithSeconds[5]))
  ) {
    return "safeWindow";
  }

  return null;
}
