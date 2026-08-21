import type { Persona } from "@/shared/types/agents";
import { describe, expect, it } from "vitest";
import { personaToSnapshot, snapshotToCreatePersonaRequest } from "./mapping";
import { SNAPSHOT_FORMAT, SNAPSHOT_VERSION, type SnapshotV1 } from "./schema";

function snapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    definition: {
      name: "Definition name",
      systemPrompt: "Portable prompt",
      provider: "anthropic",
      model: "claude",
      runtime: "/tmp/untrusted-agent",
    },
    profile: {
      displayName: "Display name",
      avatarUrl: "https://example.com/avatar.png",
    },
    memory: {
      level: "core",
      entries: [{ slug: "core", body: "secret memory" }],
    },
    sourceIdentity: { privateKey: "secret" },
    credentials: { apiKey: "secret" },
    ...overrides,
  };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "private-id",
    displayName: "Builder",
    systemPrompt: "Build carefully",
    provider: "goose",
    modelProviderId: "openai",
    model: "gpt",
    isBuiltin: false,
    writable: true,
    sourceProperties: { apiKey: "secret", command: "/usr/bin/agent" },
    ...overrides,
  };
}

describe("snapshot mappings", () => {
  it("maps supported portable configuration and ignores runtime, identity, credentials, and memory", () => {
    const request = snapshotToCreatePersonaRequest(snapshot(), {
      supportsConfiguration: (provider, model) =>
        provider === "anthropic" && model === "claude",
    });
    expect(request).toEqual({
      displayName: "Display name",
      systemPrompt: "Portable prompt",
      provider: "anthropic",
      modelProviderId: undefined,
      model: "claude",
    });
    expect(JSON.stringify(request)).not.toMatch(
      /runtime|privateKey|apiKey|memory|command/,
    );
  });

  it("leaves unsupported configuration unset for the caller's fallback flow", () => {
    expect(
      snapshotToCreatePersonaRequest(snapshot(), {
        supportsConfiguration: () => false,
      }),
    ).toEqual({
      displayName: "Display name",
      systemPrompt: "Portable prompt",
    });
  });

  it("imports a bounded PNG data avatar without persisting remote URLs", () => {
    const value = snapshot({
      profile: {
        displayName: "Portable",
        avatarDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
        avatarUrl: "https://tracking.example/avatar.png",
      },
    });

    expect(snapshotToCreatePersonaRequest(value).avatar).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    );
  });

  it("falls back to definition name and ignores dangerous avatar schemes", () => {
    const value = snapshot({
      profile: {
        displayName: " ",
        avatarUrl: "file:///etc/passwd",
        avatarDataUrl: "data:text/html;base64,WA==",
      },
    });
    expect(snapshotToCreatePersonaRequest(value).displayName).toBe(
      "Definition name",
    );
    expect(snapshotToCreatePersonaRequest(value).avatar).toBeUndefined();
  });

  it("exports a deterministic config-only snapshot with no persistent metadata or secrets", () => {
    const exported = personaToSnapshot(persona());
    expect(exported).toEqual({
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name: "Builder",
        systemPrompt: "Build carefully",
        runtime: null,
        model: "gpt",
        modelProviderId: "openai",
        provider: "goose",
        parallelism: 1,
        respondTo: null,
        respondToAllowlist: [],
        namePool: [],
        idleTimeoutSeconds: null,
        maxTurnDurationSeconds: null,
      },
      profile: {
        displayName: "Builder",
        about: null,
        avatarDataUrl: null,
        avatarUrl: null,
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /private-id|apiKey|\/usr\/bin|createdAt|sourceProperties|memory/,
    );
  });

  it.each([
    "Agent",
    "Draft",
    "  agent  ",
  ])("does not export placeholder description %j", (sourceDescription) => {
    expect(
      personaToSnapshot(persona({ sourceDescription })).profile?.about,
    ).toBeNull();
  });

  it("round-trips the reviewed public description", () => {
    const exported = personaToSnapshot(
      persona({ sourceDescription: "Builds useful things." }),
    );
    expect(snapshotToCreatePersonaRequest(exported).description).toBe(
      "Builds useful things.",
    );
  });

  it("bounds public descriptions by grapheme without failing export", () => {
    const description = "😀".repeat(120);
    const exported = personaToSnapshot(
      persona({ sourceDescription: description }),
    );
    expect(exported.profile?.about).toBe("😀".repeat(110));
    expect(snapshotToCreatePersonaRequest(exported).description).toBe(
      "😀".repeat(110),
    );
  });

  it("accepts long v1 descriptions and bounds the imported presentation copy", () => {
    const value = snapshot({
      profile: {
        displayName: "Display name",
        about: "a".repeat(200),
      },
    });
    expect(snapshotToCreatePersonaRequest(value).description).toBe(
      "a".repeat(110),
    );
  });

  it("ignores legacy trait metadata without rejecting the snapshot", () => {
    const value = snapshot({
      profile: {
        displayName: "Display name",
        goodFor: "legacy purpose",
        vibes: "legacy tone",
      },
    });

    expect(snapshotToCreatePersonaRequest(value)).not.toMatchObject({
      goodFor: expect.anything(),
      vibes: expect.anything(),
    });
  });

  it("exports safe URL and data URL avatars only", () => {
    expect(
      personaToSnapshot(persona({ avatar: "https://example.com/a.png" }))
        .profile?.avatarUrl,
    ).toBe("https://example.com/a.png");
    expect(
      personaToSnapshot(
        persona({
          avatar:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
        }),
      ).profile?.avatarDataUrl,
    ).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
    );
    expect(
      personaToSnapshot(persona({ avatar: "https://user:pass@example.com/a" }))
        .profile?.avatarUrl,
    ).toBeNull();
    expect(
      personaToSnapshot(persona({ avatar: "app-avatar:local" })).profile,
    ).toMatchObject({
      avatarDataUrl: null,
      avatarUrl: null,
    });
  });
});
