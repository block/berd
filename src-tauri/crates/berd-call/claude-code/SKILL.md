---
name: berd-call
description: Use the Berd Call CLI for live voice calls, speech delivery, call controls, voice discovery, and agent transcript integration.
---

# Berd Call

Use `berd-call` as the voice-call interface. Discover the binary with `command -v berd-call`; on macOS, also check `/Applications/Berd.app/Contents/MacOS/berd-call`. Check `berd-call --help` and command-specific help before using options.

## Starting a call

Run `berd-call start` as a background command and keep it running for the whole call. Saved settings supply the voice, speech rate, backend, and call mode, so add those flags only when the user asks to override one for this call. Use the call's actual control port for every other command; pass `--port` only when the call was started with one.

This plugin's hooks bind to the session that starts the call, from `CLAUDE_CODE_SESSION_ID`. While the call runs they hold you to it: a tool call is refused while the user has spoken and you haven't answered, and ending your turn is refused until you have answered, said something since your last tool, and are waiting for more. Subagents and other sessions are not held. Run each `berd-call` command on its own: one chained with another command is held like any other tool. When a hook refuses, do what its reason says.

Wait for the user with `berd-call wait-for-input`, which returns their input as JSON with a `cursor`. Alternatively, start the call with `--stream live` under a monitor that delivers each transcript row to you; then you don't need to poll.

## Answering

Treat `user` records as the user's speech and `handoff` records as expert requests. `spokesperson` records are context, `speech_result` records describe delivery, and `lifecycle` records describe call state.

In a conventional call, reply with `berd-call speak --re CURSOR TEXT`, where CURSOR is the newest input you have. A reply that comes back `spoke:false` missed newer input; read what it lists and reply again. Never use a speech request ID as a transcript cursor.

In an Expert–Spokesperson call, records arrive in batches, after each Spokesperson reply and at each handoff. Reply with `berd-call message-spokesperson --re CURSOR [--resolves HANDOFF_ID]... TEXT`, and the Spokesperson tells the user. Name each handoff it answers with `--resolves`, because an open handoff gets reminders and keeps the call from renewing. `speak` is refused there unless the call was started with `--allow-direct-agent-speech`; with it, `speak --re CURSOR` speaks in your own voice and no handoff is held open, so never pass `--resolves`.

## Ending

End the call with `berd-call stop` only when the user asks. If the call stops or fails, report it and do not restart it unless asked. Do not claim speech was delivered when `speak` failed.
