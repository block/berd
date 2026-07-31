# Deferred workspace first-send implementation note

**Base:** `d5ab6f32dea4c63eaea6c87e2e46af0205835a47`

## Product rules

1. Every composer submits through one first-send function.
2. On the first send, ask for a workspace name when the project requires one, then create the workspaces.
3. Keep the accepted message in the existing single queue slot until the session's included workspace attachments canonically match the configuration required for that send.
4. If creation fails, leave the message queued. Release it only when the user chooses **Send anyway** or an explicit user edit makes the attachments match.

Everything except sending another agent message remains available while the message is held. There is no persistence, retry, repair, rollback owner, second queue, registry, generalized reducer, event algebra, effect interpreter, or operation framework.

## Concrete code cut

### One send path

Add one ordinary chat helper beside the existing queue/store code. It accepts a session ID, immutable message payload, and optional startup name. It performs compare-and-insert into `queuedMessageBySession`, determines whether naming/workspace creation is needed, and either marks the record transport-ready or leaves it deferred. A second send cannot replace the occupied slot.

Route these existing paths through it:

- Main, Detached, and Home: `useChatSessionController.ts::handleSend`. Detached already shares this controller; Home keeps the existing exact-record pending-session move.
- Global: replace `AppShell.tsx::handleGlobalCompose`'s direct `enqueueTransportReadyMessage` call after draft creation.
- berdctl create: replace eager planning plus `sendPromptInBackground` in `commands/impl/createSession.ts`; require `startup_name` when UI naming would be needed.
- berdctl existing-session first send: replace the idle direct background send in `commands/impl/sendSession.ts`. Ordinary running-session follow-up queue/steer behavior stays transport-only.

The shared helper owns only first-send preparation. Existing mounted and berdctl drains remain transport senders and continue to ignore every deferred record.

### Existing queue slot and hold predicate

Keep the current `transport-ready | deferred` single-slot record. A deferred record carries the accepted payload, exact `recordId`, the desired included-workspace attachment description, and the minimum display data for naming/creating/failure. Do not add another collection or continuation object.

Put one canonical attachment/config equality helper in the chat workspace library, using normalized included workspace attachment identity/path/kind. The queue boundary uses that helper:

- matching desired and current attachments: convert the exact record to `transport-ready`;
- not matching: leave it deferred;
- **Send anyway**: convert the exact record without changing workspaces;
- explicit successful user workspace/config edit: recheck equality and convert only on a match;
- mount, refresh, timer, failed edit, or creation failure: never release.

Only the queue/store boundary converts or dismisses a deferred record. Both drains continue checking only `kind === "transport-ready"`.

### Naming and creation

Queue the payload before opening the existing `ProjectWorkspaceStartupDialog`. The dialog becomes a view over the queued record: submit supplies the name, cancel dismisses that exact record, and skip uses the existing as-is planner where allowed. Remounting does not reopen or restart work already in progress.

The submit handler calls the existing named/as-is workspace planner once. After planning and immediately before applying its result, compare the session's current canonical workspace/config snapshot with the snapshot captured when that creation call began. If it changed, stop: do not apply, patch, release, dismiss, or send. Leave the queued record failed/held. This local pre-apply check is the stale-result guard; it is not stored as an operation lifecycle and cannot release anything.

After a successful apply, re-read the exact queue record and current attachments at the store boundary. Release only if the record still matches and attachment/config equality now holds.

### Delete old authorities as each caller moves

- `AppShell.tsx`: delete `pendingProjectChatDraftRequest*`, `projectWorkspaceStartupCreating`, startup-name submit/skip/cancel promise handlers, eager planning in `createNewProjectDraft`, workspace-derived draft configuration, and its rollback branches. Keep draft creation/navigation and reuse the dialog as a view.
- Global: delete its direct transport-ready first-send insertion.
- berdctl create: delete direct named/as-is planner ownership, workspace-plan session construction, rollback handling, and direct background first send.
- berdctl existing send: delete the idle first-send direct-send bypass; retain steer and ordinary busy follow-up transport behavior.
- Do not add workspace decisions to `useMessageQueue` or `useBerdctlQueuedMessageDrain`.

There is no dual-write period: switch and delete each old first-send authority in the same change.

## Smallest test cut

1. Shared helper/store: occupied-slot rejection; naming once; creation success stays held until equality; failure stays held; Send anyway; explicit user edit match; system refresh mismatch/no release; cancel; stale pre-apply snapshot prevents apply; stale record cannot release/dismiss.
2. Queue drains: all deferred records remain inert; exact conversion wakes the mounted or idle berdctl drain; Home occupied destination preserves both records and pending state.
3. Entry points: one focused test each proving Main/Detached/Home, Global, berdctl create, and berdctl existing first send use the shared path and have no direct bypass.
4. Deletion/call-path check: no eager AppShell/berdctl planner owner and no direct first-send transport call remains.

## Size estimate and stop line

The validated queue boundary is already **+110/-76 production** and **+281/-80 tests**. The smallest remaining implementation is approximately **+120 to +190 production additions**, **+160 to +240 test additions**, and **-180 to -300 production deletions** from AppShell and berdctl eager authority. Expected complete production footprint is therefore **+230 to +300 additions before deletions**, not the prior 405–575 estimate.

Stop if the remaining implementation exceeds **190 production additions**, needs more than the one queue record plus local stale snapshot, or introduces a reducer/event/effect framework. At that point the composers have not actually been consolidated.
