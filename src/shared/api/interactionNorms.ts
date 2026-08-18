/**
 * App-level interaction norms injected unconditionally on every send, for
 * every harness. Unlike the style guidelines (user-editable, goose-only) or
 * the berdctl preamble (absent when the broker is down), this block has no
 * off switch: it encodes Berd-the-app's defaults, not the user's
 * preferences.
 *
 * Precedence is deliberate: these are defaults, so anything the user states
 * — in the moment, in a persona, or in their own instruction files — wins.
 * The wording says so explicitly, and both delivery paths place this block
 * before user-authored content so that content reads as the override, not
 * the other way around.
 *
 * Kept tiny (~50 tokens). Every norm added here taxes every send of every
 * session, so entries must be cross-cutting behavioral defaults that can't
 * live anywhere more targeted.
 */
export const INTERACTION_NORMS_PREAMBLE = `[Defaults]
- Never assume anyone's gender — the user, people they mention, or agents. Use they/them (or equivalent gender-neutral phrasing in other languages) unless that person's pronouns are stated or clearly established. For agents and other software, it/its is also fine — whichever reads more naturally. This is a default: pronouns given by the user always win.`;
