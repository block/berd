# Public Berd skills

This directory contains portable Agent Skills published by the Berd project for
independent installation. These are different from:

- `.agents/skills/`, which contains contributor workflows for working on Berd
- `distro/skills/`, which contains skills bundled with the Berd application

## Buzz Handoff

`buzz-handoff` reads Buzz channels and threads in a private agent conversation
and can send an explicitly approved message back through the public Buzz CLI.

### Requirements

- the [`buzz` CLI](https://github.com/block/buzz) on `PATH`
- Python 3.10 or newer
- `BUZZ_RELAY_URL` and `BUZZ_PRIVATE_KEY` configured outside the agent
  conversation
- `BUZZ_AUTH_TAG` when required by the configured identity

Never paste a Buzz private key into an agent conversation. This skill does not
read or export credentials from Buzz Desktop.

Buzz does not currently publish the standalone CLI as a release artifact. Build
and install it from a local checkout of [`block/buzz`](https://github.com/block/buzz)
using the repository's pinned Rust toolchain (the CLI crate declares Rust 1.88
as its minimum):

```bash
git clone https://github.com/block/buzz.git
cd buzz
cargo install --locked --path crates/buzz-cli
buzz --help
```

Update the CLI by pulling the Buzz checkout and repeating the `cargo install`
command. This skill follows Buzz's current public CLI contract on `main`; it has
no independent compatibility guarantee for older Buzz CLI builds.

### Install the skill

Install it globally with the open Agent Skills CLI so Buzz Handoff is available
across conversations and working folders:

```bash
npx skills add block/berd --skill buzz-handoff -g
```

Choose the agent harnesses where you want the skill available. Reload an open
agent application after installation.

To install it only for the current code project, omit `-g` and run the command
from that project's root:

```bash
npx skills add block/berd --skill buzz-handoff
```

### Update

Update a global installation with:

```bash
npx skills update buzz-handoff -g
```

Update a project installation from that project's root with:

```bash
npx skills update buzz-handoff --project
```

Installed files are managed copies and may be replaced during an update. Make
durable changes in this repository rather than editing an installed copy.
