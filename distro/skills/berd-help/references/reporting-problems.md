# Reporting Problems

Route app-level bugs, crashes, and feedback through an available feedback
route rather than improvising a report. Routes vary by build — verify which
exist before recommending one, and use the first that applies:

1. Run `berdctl feedback --help`. If the `feedback` subcommand exists,
   follow the guidance below. If invoking it reports that feedback is
   unavailable or disabled, continue to the next route.
2. Otherwise, check whether the app shows a visible in-app feedback action
   (labeled "Send feedback"). If it's visible, point the user there —
   don't assume it's present.
3. Otherwise, the fallback is the public issue tracker:
   https://github.com/block/berd/issues. You may help the user draft a
   report (title, description, steps to reproduce, app version, OS), but
   the user reviews and files it themselves. Never file on their behalf,
   and never invent another URL or email for reports.

When `berdctl feedback` exists:

- Prefer `berdctl feedback open --title <title> --description <description>`
  (add `--include-logs` only when the user wants diagnostics attached). This
  opens the same feedback form the UI's "Submit feedback" action opens, with
  the report prefilled — nothing is sent. The user reviews, edits, adds
  image attachments, and submits it themselves, exactly as if they had
  filled out the dialog by hand.
- `berdctl feedback submit` files the report immediately, with no review
  step and no confirmation screen — the moment it runs, a real ticket
  exists. Only use it when the user has explicitly and unambiguously asked
  to file, send, or submit feedback right now, matching the command's own
  guidance. Default to `feedback open` whenever there's any ambiguity about
  whether the user wants to review first.
- State the privacy posture accurately when asked: attaching logs (via
  `--include-logs`, either command) includes safe local metadata and
  sanitized logs. It excludes prompts, responses, tool payloads, and session
  databases — those are never attached. Logs are opt-in only; omitting
  `--include-logs` attaches nothing.
- Do not invent your own log bundle, file path, or diagnostic procedure. If
  a user needs something the feedback flow does not cover, say what it does
  cover and stop there rather than proposing a workaround that bypasses
  redaction.
- If the issue is about a specific harness's behavior (not the Berd app),
  say that it's out of scope for this flow and point them to the harness's
  own reporting channel if you know it — don't guess.
