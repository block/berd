/**
 * The one thing memory must never save.
 *
 * Everything else in this feature is guidance: prompts ask models to only
 * record what the person said, to leave sensitive areas alone unless stated
 * plainly, and the user sees anything saved with a way to delete it. That is
 * the right weight for preferences — a fact recorded in error is a nuisance,
 * and undo covers it.
 *
 * Credentials are different, because undo doesn't undo them. A saved secret
 * is written to a plain file, published into the agent files other tools
 * read, and committed to the store's history. Deleting the entry removes the
 * bullet; the commit keeps the text. So the only reliable defense is refusing
 * the write, which is why this is code and not a sentence in a prompt.
 *
 * Deliberately conservative in one direction: it would rather reject a
 * legitimate entry than admit a secret. That trade is only defensible because
 * memory is for prose about a person — "I use 1Password" passes, and there is
 * no legitimate memory entry that needs to contain an API key.
 */

/**
 * Well-known credential shapes. Prefix-matched tokens from providers that
 * publish their formats, so these are precise rather than heuristic.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{12,}/, // AWS access key ids
  /\bASIA[0-9A-Z]{12,}/, // AWS temporary keys
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /\bya29\.[0-9A-Za-z_-]+/, // Google OAuth tokens
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab tokens
  /\bnpm_[A-Za-z0-9]{30,}/, // npm tokens
  /\bshpat_[A-Fa-f0-9]{28,}/, // Shopify tokens
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, // SendGrid
  /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{20,}/, // Square tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /-{3,}\s*BEGIN [A-Z ]*PRIVATE KEY/, // PEM private keys
  /\bAAAA[A-Za-z0-9+/]{60,}/, // SSH public-key bodies (often pasted with the private half)
];

/**
 * A labelled secret: some form of "password/token/key" followed by a value.
 * Requires the value to look like a credential rather than prose, so that
 * "my password manager is 1Password" and "ask before rotating my API key"
 * both pass — those name the concept without carrying a secret.
 */
const LABELLED_SECRET =
  /\b(?:pass(?:word|wd|phrase)|secret|api[\s_-]?key|access[\s_-]?(?:key|token)|auth[\s_-]?token|bearer|private[\s_-]?key|client[\s_-]?secret|credentials?|otp|mfa[\s_-]?code|pin|cvv|routing[\s_-]?number|account[\s_-]?number|ssn|social security)\b[\s:=>-]{1,4}["'`]?([^\s"'`]{6,})/i;

/** Long unbroken runs of key-ish characters: base64/hex blobs, not prose. */
const OPAQUE_BLOB = /\b[A-Za-z0-9+/=_-]{40,}\b/;
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/;

/**
 * Short numeric secrets. A PIN, CVV, or one-time code is only a few digits —
 * under the length floor the general rule uses — so the label plus a bare
 * number is the whole signal.
 */
const LABELLED_NUMERIC =
  /\b(?:pin|cvv|cvc|otp|mfa[\s_-]?code|passcode|security[\s_-]?code|account[\s_-]?number|routing[\s_-]?number|ssn)\b[\s:=>-]{1,4}["'`]?(\d[\d\s-]{2,})/i;

/**
 * A value that reads like prose rather than a secret. Labelled matches run
 * through this so a sentence like "password reset emails go to my work
 * address" isn't mistaken for a credential.
 */
function looksLikeProse(value: string): boolean {
  if (/\s/.test(value)) return true;
  // Words, hyphenated words, and sentence fragments are prose; a secret is
  // a dense mixed-case//digit/symbol run.
  if (/^[A-Za-z][a-z]*(?:[-'][A-Za-z][a-z]*)*[.,;:!?]?$/.test(value)) {
    return true;
  }
  return false;
}

/** Shannon entropy per character — dense random strings score high. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True when an entry looks like it carries a credential and must not be
 * written to a memory file.
 *
 * Checked at the single write funnel, so it covers both doors: the noticer's
 * extraction pass and live `propose_memory` calls from any agent.
 */
export function looksLikeCredential(content: string): boolean {
  const text = content.trim();
  if (!text) return false;

  for (const pattern of TOKEN_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  const labelled = LABELLED_SECRET.exec(text);
  if (labelled) {
    const value = labelled[1];
    if (!looksLikeProse(value)) return true;
  }

  if (LABELLED_NUMERIC.test(text)) return true;

  // An opaque blob on its own is a credential regardless of any label: no
  // memory entry about a person needs a 40-character random string.
  const blob = OPAQUE_BLOB.exec(text)?.[0] ?? LONG_HEX.exec(text)?.[0];
  if (blob && entropy(blob) > 3) return true;

  return false;
}
