# Public Berd skills

This directory contains portable Agent Skills published by the Berd project for
independent installation. These are different from:

- `.agents/skills/`, which contains contributor workflows for working on Berd
- `distro/skills/`, which contains skills bundled with the Berd application

## Buzz Handoff

`buzz-handoff` reads Buzz channels and threads in a private agent conversation
and can send an explicitly approved message back through the public Buzz CLI.

### Requirements

- a [`buzz` CLI](https://github.com/block/buzz) build containing the handoff
  contract introduced by [`block/buzz@9c1e4fad2`](https://github.com/block/buzz/commit/9c1e4fad2a2ca49835f2301c85b554bcde414bdc), on `PATH`
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
git checkout investigate-buzz-cli-handoff # temporary until the contract lands on main
cargo install --locked --path crates/buzz-cli
buzz --help
```

Until that prototype contract lands on Buzz `main`, check out
`investigate-buzz-cli-handoff` before running `cargo install`. Update the CLI by
pulling the Buzz checkout and repeating the install command. The skill has no
compatibility guarantee for Buzz CLI builds that predate this contract.

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
