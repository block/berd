// Vendored typed telemetry event modules. Originally generated from
// squareup/message-schemas; the generator is not part of this repo, so these
// are ordinary source now — edit by hand and keep event/param names aligned
// with the schema repo.
//
// This is a curated subset of the schema repo's events, not a mirror of it:
// every *Initiated* variant is deliberately not vendored (Berd tracks the
// completed action, not the intent to start one), along with the other events
// the port excluded and `berd_app_feedback_submitted`, retired once dropping
// `user_id` from the wire left it with no attributes at all — a bare counter
// the resource-level install identity already implies. Alignment means the
// events that are here match the schema repo's names and params — not that
// every event the schema repo defines gets a factory. Vendor an event when a
// call site for it lands, not before.
//
// Events carry no user-generated content and no user-derived identifiers:
// `agent_id` (the persona's on-disk path — the agent's name plus the OS
// username), `project_id` (a slug of the project's name), and the pin events'
// `item_id` (paths/slugs for three of its five kinds) were all removed from
// the wire. What remains is booleans, closed enums, provider/model/app-version
// strings, and the chat events' `session_id` — an opaque backend/draft token
// kept deliberately as the one per-entity join key; the only other identity on
// the wire is the resource-level anonymous `installation.id`.
//
// Losing its id left `berd_agent_delete_completed` with no attributes at all.
// Unlike the feedback event it stays, as the precedent that an attribute-less
// event survives when its count is the signal: deletions against creations are
// net agent adoption per install, derivable from nothing else.

export type { Event } from "./event";
export * from "./berd_agent";
export * from "./berd_app";
export * from "./berd_chat";
export * from "./berd_home";
export * from "./berd_project";
export * from "./berd_voice";
