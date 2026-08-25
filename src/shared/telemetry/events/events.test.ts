import { describe, expect, it } from "vitest";

import * as events from ".";
import {
  berdAgentCreateCompleted,
  berdAgentDeleteCompleted,
  berdAgentEditCompleted,
} from "./berd_agent";
import { berdAppLifecycleLaunched } from "./berd_app";
import { berdChatMessageSent, berdChatSessionStarted } from "./berd_chat";
import { berdHomePinPinned, berdHomeUnpinUnpinned } from "./berd_home";
import {
  berdProjectCreateCompleted,
  berdProjectDeleteCompleted,
  berdProjectEditCompleted,
} from "./berd_project";
import { berdVoiceConversationStarted } from "./berd_voice";

// The vendored set is a curated subset of the schema repo (see ./index.ts): the
// port excluded every *Initiated* variant, so a factory for one has no call
// site by construction. `berdAppFeedbackInitiated` survived the port as the
// lone exception and sat dead until it was removed; this pins that re-vendoring
// one is a deliberate decision, not a silent drift back toward the schema repo.
describe("vendored event surface", () => {
  it("exposes no Initiated factories", () => {
    expect(Object.keys(events).filter((n) => n.endsWith("Initiated"))).toEqual(
      [],
    );
  });

  // Its Submitted counterpart was retired for a different reason: dropping
  // `user_id` from the wire left it carrying nothing, and a bare counter is
  // already implied by the resource-level install identity. Same pin, so
  // re-vendoring it is a decision someone makes on purpose.
  it("exposes no factory for the retired feedback event", () => {
    expect(Object.keys(events)).not.toContain("berdAppFeedbackSubmitted");
  });
});

describe("voice events", () => {
  it("keeps successful voice startup as a privacy-safe bare counter", () => {
    expect(berdVoiceConversationStarted()).toEqual({
      name: "berd_voice_conversation_started",
      parameters: {},
    });
  });
});

// The entity-id attributes left the wire the same way `user_id` did: the
// gateway's strict schema models no `agent_id` (the persona's on-disk path —
// the agent's name plus the OS username), no `project_id` (a slug of the
// project's name), and no `item_id` (a path or slug for three of its five
// kinds), so a factory that reintroduces one produces a 400, not an extra
// column. The chat events' `session_id` is the deliberate exception — an
// opaque backend/draft token, kept as the one per-entity join key.
describe("removed entity-id params", () => {
  it("puts no id on the agent events, leaving delete a bare counter", () => {
    const created = berdAgentCreateCompleted({
      provider: "goose",
      model: "goose-claude-4-5-sonnet",
    });
    const edited = berdAgentEditCompleted({ provider: "goose" });

    expect(created.parameters).not.toHaveProperty("agent_id");
    expect(edited.parameters).not.toHaveProperty("agent_id");
    expect(berdAgentDeleteCompleted().parameters).toEqual({});
  });

  it("puts no id on the project events", () => {
    const created = berdProjectCreateCompleted({
      has_working_dir: true,
      has_prompt: false,
    });
    const edited = berdProjectEditCompleted({
      has_working_dir: false,
      has_prompt: true,
    });
    const deleted = berdProjectDeleteCompleted({
      had_working_dir: true,
      had_artifact: true,
    });

    for (const ev of [created, edited, deleted]) {
      expect(ev.parameters).not.toHaveProperty("project_id");
    }
  });

  it("puts no id on the pin events", () => {
    const pinned = berdHomePinPinned({ item_type: "HOME_ITEM_TYPE_AGENT" });
    const unpinned = berdHomeUnpinUnpinned({
      item_type: "HOME_ITEM_TYPE_CHAT",
    });

    expect(pinned.parameters).toEqual({ item_type: "HOME_ITEM_TYPE_AGENT" });
    expect(unpinned.parameters).toEqual({ item_type: "HOME_ITEM_TYPE_CHAT" });
  });
});

// Absent optional params must be omitted from the parameters object entirely.
// sdk-logs accepts `undefined` attribute values and the OTLP transformer
// serializes them as the empty `{"value": {}}` encoding, so an always-set
// `provider: params.provider` would put keys without values on the wire — the
// ingestion gateway's allowlist expects the keys only when they carry one.
describe("optional event params", () => {
  // `environment` is optional for one reason only: `BerdAppEnvironment` has no
  // member for a development build, so the client hands over nothing there
  // rather than coercing one of the two wire values (see
  // `launchEventEnvironment` in ../client.ts).
  it("carries or omits environment on berd_app_lifecycle_launched", () => {
    const staging = berdAppLifecycleLaunched({
      app_version: "1.2.3",
      environment: "staging",
    });
    const development = berdAppLifecycleLaunched({
      app_version: "1.2.3",
      environment: undefined,
    });

    expect(staging.parameters).toEqual({
      app_version: "1.2.3",
      environment: "staging",
    });
    expect("environment" in development.parameters).toBe(false);
  });

  it("omits absent provider/model from berd_chat_session_started", () => {
    const ev = berdChatSessionStarted({
      session_id: "session-1",
      source_surface: "CHAT_SOURCE_SURFACE_MAIN_CHAT",
      has_project: false,
      has_persona: false,
    });

    expect("provider" in ev.parameters).toBe(false);
    expect("model" in ev.parameters).toBe(false);
  });

  it("omits absent provider/model from berd_chat_message_sent", () => {
    const ev = berdChatMessageSent({
      session_id: "session-1",
      is_first_message: true,
      has_attachments: false,
      has_persona: false,
    });

    expect("provider" in ev.parameters).toBe(false);
    expect("model" in ev.parameters).toBe(false);
  });

  it("omits absent provider/model from berd_agent create/edit", () => {
    const created = berdAgentCreateCompleted({});
    const edited = berdAgentEditCompleted({
      model: undefined,
    });

    expect("provider" in created.parameters).toBe(false);
    expect("model" in created.parameters).toBe(false);
    expect("provider" in edited.parameters).toBe(false);
    expect("model" in edited.parameters).toBe(false);
  });

  it("keeps provider/model when they are present", () => {
    const ev = berdChatMessageSent({
      session_id: "session-1",
      is_first_message: false,
      has_attachments: false,
      has_persona: true,
      provider: "goose",
      model: "goose-claude-4-5-sonnet",
    });

    expect(ev.parameters.provider).toBe("goose");
    expect(ev.parameters.model).toBe("goose-claude-4-5-sonnet");
  });
});
