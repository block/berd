# Contributing to Berd

Berd is developed by a small team at Block, in the open. You can read every line
of the source, build it yourself, fork it, and tell us when it breaks.

**We do not accept pull requests from outside the maintainer team.** Please do
not spend your time on one — see [Why we don't take outside PRs](#why-we-dont-take-outside-prs)
below.

**The way to participate is to open a well-formed issue.** A good issue is
genuinely valuable to us and takes real effort to write. This document tells you
exactly what "well-formed" means.

- [Filing an issue](#filing-an-issue)
  - [Using an agent](#using-an-agent)
  - [Before you file](#before-you-file)
  - [Bug reports](#bug-reports)
  - [Feature requests](#feature-requests)
- [What happens next](#what-happens-next)
- [Why we don't take outside PRs](#why-we-dont-take-outside-prs)
- [Security issues](#security-issues)
- [Building Berd yourself](#building-berd-yourself)
- [For maintainers](#for-maintainers)

---

## Filing an issue

Open issues at **https://github.com/block/berd/issues/new/choose**.

There are two kinds, and the forms enforce the required fields:

| Kind | Use it when |
| --- | --- |
| **Bug report** | Berd does something other than what it says it does. |
| **Feature request** | You want Berd to do something it doesn't, or to do something existing noticeably better. |

Free-form issues are disabled. Pick a form.

### Using an agent

You're welcome — encouraged, really — to have a coding agent help you write the
issue. It's good at gathering version numbers, trimming logs, and writing crisp
repro steps. Paste this to your agent of choice:

```
Read https://raw.githubusercontent.com/block/berd/main/CONTRIBUTING.md
and help me file a Berd issue. Interview me for anything the guide
requires that I haven't given you, and tell me if what I'm reporting
is actually two separate issues.
```

Two rules if you do:

- **You are the author, not the agent.** Read what it wrote before you post it.
  If you can't answer a question about your own issue, it isn't ready.
- **Do not let it invent details.** An agent guessing at a version number or
  paraphrasing an error it never saw is worse than a blank field. Write
  "unknown" instead.

We can tell the difference between an agent that helped you investigate and an
agent that padded a thin report into something that looks thorough. The second
kind gets closed.

### Before you file

Every issue must clear these three bars. The forms ask you to confirm each one.

**1. Search first.** Look through
[open and closed issues](https://github.com/block/berd/issues?q=is%3Aissue).
Link the closest thing you found, or say "none found". If someone already
reported it, add your details to that thread — a second data point on an
existing bug is more useful than a duplicate.

**2. Reproduce on the current version.** Update to the
[latest release](https://github.com/block/berd/releases) and confirm the problem
is still there. We can't act on reports against builds we've already moved past.

**3. One issue per issue.** If your report has an "and also", split it. Bundled
issues can't be triaged, assigned, or closed cleanly.

### Bug reports

A bug report earns its keep by letting a maintainer reproduce the problem
without asking you anything. That means:

**Steps to reproduce** — numbered, starting from a freshly launched Berd.
Include what you clicked, what you typed, which model and provider you were
using, and whether the chat had prior history. "Send a message and it hangs" is
not reproducible. "New chat, Claude Sonnet via Anthropic, ask it to read a file
over 2MB, hangs at ~10s" is.

**Expected vs. actual** — two separate statements. Skipping "expected" seems
obvious to you and frequently isn't to us; sometimes the answer is that Berd is
working as designed and the design is wrong, which is a different fix.

**Frequency** — every time, intermittently, or once. This changes how we chase
it more than almost anything else you can tell us.

**Version and platform** — exact version and OS. In Berd:
**Settings → About**. If Berd won't launch, say so and give us your OS.

**Logs** — the relevant excerpt, not the whole file, and not a screenshot of
text. The app log is `berd.log`, alongside rotated `berd_<timestamp>.log`
archives:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Logs/xyz.block.berd/` |
| Linux | `~/.local/share/xyz.block.berd/logs/` |
| Windows | `%LOCALAPPDATA%\xyz.block.berd\logs\` |

If the problem involves the agent backend rather than the app shell — a hung
turn, a tool that never returns, a model error — the backend keeps its own logs
under the Goose state directory (`~/Library/Application Support/Block/goose/state/logs/`
on macOS, `~/.local/state/Block/goose/logs/` on Linux). The `server/` subtree is
usually the interesting one.

Find the lines around when the problem happened and paste those, in a fenced
code block. **Scrub them first** — logs can contain file paths, prompts, and
project names you may not want public. If there's genuinely nothing relevant,
say "no relevant log output" so we know you looked.

**Screenshots or a recording** for anything visual. A five-second capture of a
layout glitch saves an hour of back-and-forth.

### Feature requests

The bar here is different: we need to understand the *problem*, not just your
proposed solution.

**The problem, in your terms** — what were you trying to get done, and what
made it hard? Lead with this. A request framed only as a solution ("add a
setting for X") hides the problem behind it, and the problem often has a better
answer than the one you'd have asked for.

**What you do today** — your current workaround, however ugly, or "nothing, I
gave up". This tells us how much the gap actually costs you.

**Why it belongs in Berd** — Berd is extensible on purpose. Before asking for
core surface area, consider whether it could be a
[skill](https://github.com/block/berd/tree/main/.agents/skills), an agent, an
extension, or an automation. If it could and you still think it should be
built in, say why. If it genuinely can't be done from outside, say that — it's
a strong argument.

**Non-goals** — what you're explicitly *not* asking for. This is the single most
useful line in a feature request and almost nobody writes it. It tells us where
the edges of your idea are.

**Alternatives you considered** — including the ones you rejected, and why.

---

## What happens next

We triage on a best-effort basis. Berd is built by a small team with its own
roadmap, and no timeline is promised.

Your issue will get one of:

- **A label and a place in the queue** — we understand it and it's real.
- **`needs-info`** — we can't act yet. Answer the questions and it comes back to
  the queue. If a `needs-info` issue goes quiet for 30 days, we close it; comment
  any time to reopen.
- **Closed as duplicate** — with a link to the original. Follow that thread.
- **Closed as out of scope** — with a reason. This isn't a judgment on the idea;
  Berd just isn't going to be the thing that does it.

Closed doesn't mean unwelcome. A clearly-written out-of-scope request still tells
us something about what people want.

---

## Why we don't take outside PRs

Berd is early, and its architecture is still moving underneath us. Reviewing
external patches against a design that's changing weekly costs us more than it
saves, and it isn't fair to you — we'd be sitting on your work while the ground
shifts under it.

Anyone can open a PR against a public repo; GitHub offers no way to prevent it.
So PRs from outside the maintainer team are **closed automatically** with a
pointer back to this document. That's a policy, not a comment on your code.

What we want from you instead is the issue. A well-researched bug report with
clean repro steps is worth more to us right now than a patch, because it's the
part we can't do ourselves.

If this changes, it'll change here first.

---

## Security issues

**Do not open a public issue for a security vulnerability.** See
[SECURITY.md](SECURITY.md) for private disclosure.

---

## Building Berd yourself

You don't need our permission to build, run, fork, or modify Berd — it's Apache
2.0 licensed. See the [README](README.md) for `just setup` and `just dev`, and
[AGENTS.md](AGENTS.md) for how the codebase is organized.

Building it locally is also the best way to write a great bug report.

---

## For maintainers

Contribution setup, review expectations, and the Block-wide baseline:

- [Block General Contribution Guidelines](https://github.com/block/.github/blob/main/CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md) — applies to everyone, in issues and PRs alike
- [AGENTS.md](AGENTS.md) and [LAWS](LAWS) — architecture rules the codebase is held to
- [DESIGN.md](DESIGN.md) — design system and token usage
