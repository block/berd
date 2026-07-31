/**
 * Playwright custom fixture that injects a Tauri IPC mock into the page
 * before every navigation. This allows E2E tests to run against the frontend
 * without the real Tauri backend.
 *
 * Also installs a `window.WebSocket` stub for the ACP connection so features
 * like skills (which use `client.extMethod("_goose/sources/...")`) can run
 * without a live goose-acp server.
 */

import { test as base, expect, type Page } from "@playwright/test";
import { MOCK_PERSONAS, MOCK_PROJECTS, MOCK_SKILLS } from "./mock-data";

/**
 * Build the init script that will be injected into the page via
 * `page.addInitScript()`. The script sets up `window.__TAURI_INTERNALS__`
 * with an `invoke` handler that returns mock data for every Tauri command
 * the app is known to call, plus a WebSocket mock for ACP traffic.
 *
 * Callers can override the default personas and skills arrays to test
 * empty-state or custom scenarios.
 */
export function buildInitScript(options?: {
  personas?: unknown[];
  skills?: unknown[];
  projects?: unknown[];
  sessions?: unknown[];
  voiceConversationStatus?: unknown;
  enabledExperiments?: string[];
  providerCatalog?: unknown[];
  providerInventory?: unknown[];
  agentSetupFailure?: {
    providerId: string;
    lines: string[];
    errorMessage: string;
  };
}): string {
  const personas = JSON.stringify(options?.personas ?? MOCK_PERSONAS);
  const skills = JSON.stringify(options?.skills ?? MOCK_SKILLS);
  const projects = JSON.stringify(options?.projects ?? MOCK_PROJECTS);
  const sessions = JSON.stringify(options?.sessions ?? []);
  const voiceConversationStatus = JSON.stringify(
    options?.voiceConversationStatus ?? {
      available: false,
      unavailableReason: "Voice conversation unavailable in browser E2E",
      lifecycle: "unavailable",
      sessionId: null,
      revision: 0,
    },
  );
  const enabledExperiments = JSON.stringify(options?.enabledExperiments ?? []);
  const providerCatalog = JSON.stringify(options?.providerCatalog ?? []);
  const providerInventory = JSON.stringify(
    options?.providerInventory ?? [
      {
        providerId: "claude",
        providerName: "Claude",
        description: "Claude provider",
        defaultModel: "claude-sonnet-4-20250514",
        configured: true,
        providerType: "Preferred",
        category: "model",
        configKeys: [],
        setupSteps: [],
        supportsRefresh: true,
        refreshing: false,
        lastUpdatedAt: null,
        lastRefreshAttemptAt: null,
        lastRefreshError: null,
        stale: false,
        modelSelectionHint: null,
        models: [
          {
            id: "claude-sonnet-4-20250514",
            name: "Claude Sonnet 4",
            family: "Claude",
            recommended: true,
          },
        ],
      },
      {
        providerId: "openai",
        providerName: "OpenAI",
        description: "OpenAI provider",
        defaultModel: "gpt-4.1",
        configured: true,
        providerType: "Preferred",
        category: "model",
        configKeys: [],
        setupSteps: [],
        supportsRefresh: true,
        refreshing: false,
        lastUpdatedAt: null,
        lastRefreshAttemptAt: null,
        lastRefreshError: null,
        stale: false,
        modelSelectionHint: null,
        models: [
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            family: "OpenAI",
            recommended: true,
          },
        ],
      },
    ],
  );
  const agentSetupFailure = JSON.stringify(options?.agentSetupFailure ?? null);

  return `
    (() => {
      const PERSONAS = ${personas};
      const SKILLS = ${skills};
      const PROJECTS = ${projects};
      const SEED_SESSIONS = ${sessions};
      const VOICE_CONVERSATION_STATUS = ${voiceConversationStatus};
      const ENABLED_EXPERIMENTS = ${enabledExperiments};
      const PROVIDER_CATALOG = ${providerCatalog};
      const PROVIDER_INVENTORY = ${providerInventory};
      const AGENT_SETUP_FAILURE = ${agentSetupFailure};
      const DISTRO = {
        present: false,
      };
      const RUNTIME_CONFIG_RESULT = {
        status: "ready",
        source: "appDefault",
        config: {
          schemaVersion: 1,
          goose: {
            defaultModelProviderId: "openai",
            defaultModelId: "gpt-4.1",
            modelProviders: [
              {
                id: "openai",
                displayName: "OpenAI",
                models: [
                  {
                    id: "gpt-4.1",
                    name: "GPT-4.1",
                    recommended: true,
                  },
                ],
              },
            ],
          },
        },
      };
      const FAKE_ACP_URL = "ws://127.0.0.1:0/mock-acp";
      const ACP_SESSIONS = SEED_SESSIONS.map((session) => ({
        sessionId: session.sessionId,
        title: session.title ?? "New Chat",
        updatedAt: session.updatedAt ?? new Date().toISOString(),
        messageCount: session.messageCount ?? 0,
        conversationBefore: session.conversationBefore,
        providerId: session.providerId ?? "goose",
        modelId: session.modelId ?? null,
      }));
      const CALLBACKS = new Map();
      const EVENT_LISTENERS = new Map();
      const ACP_SOCKETS = new Set();
      const LAYOUT_CONSTRAINTS = {
        minCenter: -1000000,
        maxCenter: 1000000,
        minSize: 1,
        maxSize: 100000,
        minZoomBps: 1000,
        maxZoomBps: 80000,
        maxTitleOverrideLength: 200,
        maxItems: 500,
      };
      let HOME_LAYOUT = {
        layoutId: "home",
        itemRevision: 1,
        cameraRevision: 1,
        camera: {
          centerX: 0,
          centerY: 0,
          zoomBps: 10000,
        },
        items: [],
        constraints: LAYOUT_CONSTRAINTS,
      };
      let nextCallbackId = 1;
      let nextEventId = 1;

      localStorage.setItem("goose:defaultProvider", "goose");
      if (ENABLED_EXPERIMENTS.length > 0) {
        localStorage.setItem(
          "goose:experimental-features",
          JSON.stringify({
            version: 2,
            experiments: Object.fromEntries(
              ENABLED_EXPERIMENTS.map((id) => [id, { enabled: true }]),
            ),
          }),
        );
      }
      localStorage.setItem(
        "goose:preferredModelsByAgent",
        JSON.stringify({
          goose: {
            providerId: "openai",
            modelId: "gpt-4.1",
            modelName: "GPT-4.1",
          },
        }),
      );

      const persistAgentSources = () => {
        sessionStorage.setItem("goose:e2e:agentSources", JSON.stringify(AGENT_SOURCES));
      };

      const slugify = (name) =>
        String(name ?? "agent")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 64)
          .replace(/-+$/g, "") || "agent";

      const clone = (value) => JSON.parse(JSON.stringify(value));

      const skillToSourceEntry = (s) => ({
        type: "skill",
        name: s.name,
        description: s.description,
        content: s.instructions ?? s.content ?? "",
        path: (s.path ?? ("/mock/.agents/skills/" + s.name + "/SKILL.md")).replace(/\\/SKILL\\.md$/, ""),
        global: s.global ?? true,
        supportingFiles: [],
      });

      const personaToSourceEntry = (p) => {
        const avatarValue = typeof p.avatar === "string" ? p.avatar : p.avatar?.value;
        return {
          type: "agent",
          name: p.displayName ?? p.name,
          description: "Agent",
          content: p.systemPrompt ?? p.content ?? "",
          path:
            p.id && String(p.id).startsWith("/")
              ? p.id
              : "/mock/.agents/agents/" + slugify(p.id ?? p.displayName ?? p.name ?? "agent") + ".md",
          global: true,
          writable: p.writable ?? !p.isBuiltin,
          supportingFiles: [],
          properties: {
            ...(p.provider ? { provider: p.provider } : {}),
            ...(p.model ? { model: p.model } : {}),
            ...(avatarValue ? { avatar: avatarValue } : {}),
          },
        };
      };

      const markdownScalar = (value) => {
        if (typeof value === "boolean" || typeof value === "number") {
          return String(value);
        }
        return JSON.stringify(String(value ?? ""));
      };

      const agentSourceToMarkdown = (source) => {
        const properties = source.properties ?? {};
        const frontmatter = {
          name: source.name,
          description: source.description ?? "Agent",
          ...properties,
        };
        const lines = Object.entries(frontmatter).map(
          ([key, value]) => key + ": " + markdownScalar(value),
        );
        return "---\\n" + lines.join("\\n") + "\\n---\\n\\n" + (source.content ?? "");
      };

      let AGENT_SOURCES = (() => {
        const stored = sessionStorage.getItem("goose:e2e:agentSources");
        if (stored) {
          try {
            return JSON.parse(stored);
          } catch (_error) {
            sessionStorage.removeItem("goose:e2e:agentSources");
          }
        }
        return PERSONAS.map(personaToSourceEntry);
      })();
      const SKILL_SOURCES = SKILLS.map(skillToSourceEntry);
      const POCKET_VOICE_SPOKEN_TEXTS = [];

      window.__GOOSE_E2E__ = {
        listAgentSources: () => clone(AGENT_SOURCES),
        clearAgentSources: () => {
          AGENT_SOURCES = PERSONAS.map(personaToSourceEntry);
          persistAgentSources();
        },
        emitAcpNotification: (params) => {
          const notification = {
            jsonrpc: "2.0",
            method: "session/update",
            params,
          };
          for (const socket of [...ACP_SOCKETS]) {
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify(notification),
              }),
            );
          }
        },
        emitTauriEvent,
        pocketVoiceSpokenTexts: () => clone(POCKET_VOICE_SPOKEN_TEXTS),
      };

      function nowIso() {
        return new Date().toISOString();
      }

      function buildSession(sessionId, providerId = "goose") {
        return {
          sessionId,
          title: "New Chat",
          updatedAt: nowIso(),
          messageCount: 0,
          conversationBefore: undefined,
          providerId,
          modelId: null,
        };
      }

      function findSession(sessionId) {
        return ACP_SESSIONS.find((session) => session.sessionId === sessionId) ?? null;
      }

      function jsonRpcResult(id, result) {
        return { jsonrpc: "2.0", id, result };
      }

      function providerEntries(providerIds) {
        const ids = Array.isArray(providerIds) ? providerIds.filter(Boolean) : [];
        if (ids.length === 0) {
          return clone(PROVIDER_INVENTORY);
        }
        return clone(PROVIDER_INVENTORY.filter((entry) => ids.includes(entry.providerId)));
      }

      function emitTauriEvent(event, payload) {
        const listeners = EVENT_LISTENERS.get(event);
        if (!listeners) {
          return;
        }
        for (const [eventId, handlerId] of [...listeners.entries()]) {
          const callback = CALLBACKS.get(handlerId);
          callback?.({
            id: eventId,
            event,
            payload,
          });
        }
      }

      function handleAcpRequest(message) {
        switch (message.method) {
          case "initialize":
            return jsonRpcResult(message.id, {
              protocolVersion: "0.1.0",
              agentCapabilities: {
                loadSession: {},
                listSessions: {},
                fork: {},
              },
              agentInfo: {
                name: "mock-goose",
                version: "0.0.0",
              },
              authMethods: [],
            });
          case "session/list":
            return jsonRpcResult(message.id, {
              sessions: ACP_SESSIONS.map((session) => ({
                sessionId: session.sessionId,
                title: session.title,
                updatedAt: session.updatedAt,
                _meta: {
                  messageCount: session.messageCount,
                },
              })),
            });
          case "session/new": {
            const providerId = message.params?.meta?.provider ?? "goose";
            const sessionId = "session-" + Math.random().toString(36).slice(2, 10);
            ACP_SESSIONS.unshift(buildSession(sessionId, providerId));
            return jsonRpcResult(message.id, { sessionId });
          }
          case "session/fork": {
            const source = findSession(message.params?.sessionId);
            const sessionId = "session-fork-" + Math.random().toString(36).slice(2, 10);
            const copy = {
              sessionId,
              title: source?.title ?? "New Chat",
              updatedAt: nowIso(),
              messageCount: source?.messageCount ?? 0,
              providerId: source?.providerId ?? "goose",
              modelId: source?.modelId ?? null,
              conversationBefore: message.params?._meta?.conversationBefore,
            };
            ACP_SESSIONS.unshift(copy);
            return jsonRpcResult(message.id, {
              sessionId,
              _meta: {
                messageCount: copy.messageCount,
                providerId: copy.providerId,
                modelId: copy.modelId,
                createdAt: copy.updatedAt,
              },
            });
          }
          case "_goose/unstable/session/rename":
          case "_goose/session/rename": {
            const session = findSession(message.params?.sessionId);
            if (session && typeof message.params?.title === "string") {
              session.title = message.params.title;
              session.updatedAt = nowIso();
            }
            return jsonRpcResult(message.id, {});
          }
          case "session/load":
            return jsonRpcResult(message.id, {});
          case "session/set_config_option": {
            const session = findSession(message.params?.sessionId);
            if (session) {
              if (message.params?.configId === "provider") {
                session.providerId = message.params?.value ?? session.providerId;
                session.modelId = null;
              }
              if (message.params?.configId === "model") {
                session.modelId = message.params?.value ?? null;
              }
              session.updatedAt = nowIso();
            }
            return jsonRpcResult(message.id, {});
          }
          case "session/prompt": {
            const session = findSession(message.params?.sessionId);
            if (session) {
              session.messageCount += 1;
              session.updatedAt = nowIso();
            }
            const promptBlocks = Array.isArray(message.params?.prompt)
              ? message.params.prompt
              : [];
            const userText =
              promptBlocks
                .filter((block) => !block.annotations?.audience?.includes("assistant"))
                .map((block) => block.text ?? "")
                .join(" ")
                .trim() || "";
            const targetPath = promptBlocks
              .map((block) => block.text ?? "")
              .join("\\n")
              .match(/persona at ([^\\s]+\\.md)/)?.[1];
            const targetSource =
              AGENT_SOURCES.find((source) => source.path === targetPath) ??
              AGENT_SOURCES.find((source) => source.properties?.draft === true);
            if (targetSource && /snarky code reviewer/i.test(userText)) {
              targetSource.name = "Snarky Code Reviewer";
              targetSource.description = "Agent";
              targetSource.content =
                "You are a snarky but constructive code reviewer. Be direct, specific, and useful.";
              targetSource.properties = {
                ...(targetSource.properties ?? {}),
                provider: "openai",
                model: "gpt-4.1",
              };
              persistAgentSources();
            }
            return jsonRpcResult(message.id, { stopReason: "end_turn" });
          }
          case "_goose/providers/list":
          case "_goose/unstable/providers/list":
            return jsonRpcResult(message.id, {
              entries: providerEntries(message.params?.providerIds),
            });
          case "_goose/providers/setup/catalog/list":
          case "_goose/unstable/providers/setup/catalog/list":
            return jsonRpcResult(message.id, { providers: clone(PROVIDER_CATALOG) });
          case "_goose/providers/inventory/refresh":
          case "_goose/unstable/providers/inventory/refresh":
            return jsonRpcResult(message.id, { started: [], skipped: [] });
          case "_goose/defaults/read":
          case "_goose/defaults/save":
            return jsonRpcResult(message.id, {
              providerId: message.params?.providerId ?? "openai",
              modelId: message.params?.modelId ?? "gpt-4.1",
            });
          case "_goose/unstable/config/extensions/list":
          case "_goose/unstable/session/extensions/list":
            return jsonRpcResult(message.id, { extensions: [] });
          case "_goose/unstable/config/extensions/add":
          case "_goose/unstable/config/extensions/remove":
          case "_goose/unstable/config/extensions/set-enabled":
            return jsonRpcResult(message.id, {});
          case "_goose/onboarding/import/scan":
            return jsonRpcResult(message.id, { candidates: [] });
          case "_goose/onboarding/import/apply":
            return jsonRpcResult(message.id, {
              imported: {
                providers: 0,
                extensions: 0,
                sessions: 0,
                skills: 0,
                projects: 0,
                preferences: 0,
              },
              skipped: {
                providers: 0,
                extensions: 0,
                sessions: 0,
                skills: 0,
                projects: 0,
                preferences: 0,
              },
              warnings: [],
            });
          case "_goose/working_dir/update":
          case "goose/working_dir/update":
            return jsonRpcResult(message.id, {});
          case "_goose/sources/list":
          case "_goose/unstable/sources/list":
            return jsonRpcResult(message.id, {
              sources:
                message.params?.type === "agent"
                  ? clone(AGENT_SOURCES)
                  : clone(SKILL_SOURCES),
            });
          case "_goose/sources/create":
          case "_goose/unstable/sources/create": {
            const type = message.params?.type ?? "skill";
            const name = message.params?.name ?? (type === "agent" ? "new-agent" : "new-skill");
            const source = {
              name,
              type,
              description: message.params?.description ?? "",
              content: message.params?.content ?? "",
              path:
                type === "agent"
                  ? "/mock/.agents/agents/" + slugify(name) + ".md"
                  : "/mock/.agents/skills/" + slugify(name),
              global: message.params?.global ?? true,
              writable: true,
              supportingFiles: [],
              properties: message.params?.properties ?? {},
            };
            if (type === "agent") {
              AGENT_SOURCES.push(source);
              persistAgentSources();
            }
            return jsonRpcResult(message.id, {
              source,
            });
          }
          case "_goose/sources/update":
          case "_goose/unstable/sources/update":
          case "goose/sources/update": {
            const path = message.params?.path ?? "/mock/.agents/skills/updated-skill";
            const sources = message.params?.type === "agent" ? AGENT_SOURCES : SKILL_SOURCES;
            const existingIndex = sources.findIndex((source) => source.path === path);
            const existingSource = existingIndex >= 0 ? sources[existingIndex] : null;
            const source = {
              name: message.params?.name ?? existingSource?.name ?? "updated-skill",
              type: message.params?.type ?? existingSource?.type ?? "skill",
              description: message.params?.description ?? existingSource?.description ?? "",
              content: message.params?.content ?? existingSource?.content ?? "",
              path,
              global: message.params?.global ?? existingSource?.global ?? true,
              supportingFiles: [],
              writable: existingSource?.writable ?? true,
              properties:
                message.params?.properties ?? existingSource?.properties ?? {},
            };
            if (existingIndex >= 0) {
              sources[existingIndex] = source;
            }
            if (message.params?.type === "agent") {
              persistAgentSources();
            }
            return jsonRpcResult(message.id, {
              source,
            });
          }
          case "_goose/sources/delete":
          case "_goose/unstable/sources/delete":
          case "goose/sources/delete":
            if (message.params?.type === "agent") {
              AGENT_SOURCES = AGENT_SOURCES.filter(
                (source) => source.path !== message.params?.path,
              );
              persistAgentSources();
            }
            return jsonRpcResult(message.id, {});
          case "_goose/sources/export":
          case "_goose/unstable/sources/export":
          case "goose/sources/export": {
            const path = message.params?.path ?? "/mock/.agents/skills/skill";
            const name = String(path).split("/").filter(Boolean).at(-1) ?? "skill";
            return jsonRpcResult(message.id, {
              json: "{}",
              filename: name + (message.params?.type === "agent" ? ".agent.json" : ".skill.json"),
            });
          }
          case "_goose/sources/import":
          case "_goose/unstable/sources/import":
            return jsonRpcResult(message.id, { sources: PERSONAS.map(personaToSourceEntry) });
          default:
            return jsonRpcResult(message.id, {});
        }
      }

      class MockWebSocket extends EventTarget {
        constructor(url) {
          super();
          this.url = url;
          this.readyState = 0;
          ACP_SOCKETS.add(this);
          queueMicrotask(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
          });
        }

        send(raw) {
          const message = JSON.parse(raw);
          const response =
            message && typeof message === "object" && "id" in message
              ? handleAcpRequest(message)
              : null;
          if (!response) {
            return;
          }
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify(response),
              }),
            );
          });
        }

        close() {
          this.readyState = 3;
          ACP_SOCKETS.delete(this);
          this.dispatchEvent(new CloseEvent("close"));
        }
      }

      window.WebSocket = MockWebSocket;

      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: {
            label: "main",
          },
        },
        invoke(cmd, args) {
          switch (cmd) {
            // ---- ACP transport ----
            case "get_goose_serve_url":
              return Promise.resolve(FAKE_ACP_URL);
            case "get_voice_conversation_status":
            case "get_native_voice_conversation_status":
              return Promise.resolve(clone(VOICE_CONVERSATION_STATUS));
            case "drain_native_voice_conversation_transcripts":
              return Promise.resolve([]);
            case "acknowledge_native_voice_conversation_transcript":
              return Promise.resolve(null);
            case "reject_native_voice_conversation_transcript":
              return Promise.resolve({ attempts: 1, terminal: false });
            case "get_pocket_voice_status":
              return Promise.resolve({
                installed: true,
                downloading: false,
                downloadedBytes: 278120564,
                totalBytes: 278120564,
                error: null,
                selectedVoice: "mary",
                playbackSpeed: 1,
                voices: [{ id: "mary", name: "Mary" }],
              });
            case "speak_pocket_voice":
              POCKET_VOICE_SPOKEN_TEXTS.push(args?.text);
              return new Promise((resolve) =>
                window.setTimeout(() => resolve(null), 50),
              );
            case "stop_pocket_voice":
              return Promise.resolve(null);
            case "get_distro_bundle":
              return Promise.resolve(DISTRO);
            case "get_runtime_config":
            case "refresh_runtime_config":
              return Promise.resolve(clone(RUNTIME_CONFIG_RESULT));
            case "list_agent_setup_status":
            case "list_model_setup_status":
              return Promise.resolve([]);
            case "migration_status":
            case "mark_migration_complete":
            case "dismiss_migration_banner":
              return Promise.resolve({
                done: true,
                disabledExtensions: [],
                backupPath: null,
                bannerDismissedAt: null,
              });
            case "backup_goose_config":
              return Promise.resolve({
                backedUp: false,
                backupPath: null,
              });
            case "log_renderer_event":
            case "write_diagnostic_event":
              return Promise.resolve(null);
            case "ensure_directory":
              return Promise.resolve(null);
            case "get_layout":
              return Promise.resolve(clone(HOME_LAYOUT));
            case "save_layout_items":
              HOME_LAYOUT = {
                ...HOME_LAYOUT,
                itemRevision: HOME_LAYOUT.itemRevision + 1,
                items: clone(args?.request?.items ?? []),
              };
              return Promise.resolve({
                ok: true,
                layout: clone(HOME_LAYOUT),
              });
            case "save_layout_camera":
              HOME_LAYOUT = {
                ...HOME_LAYOUT,
                cameraRevision: HOME_LAYOUT.cameraRevision + 1,
                camera: clone(args?.request?.camera ?? HOME_LAYOUT.camera),
              };
              return Promise.resolve({
                ok: true,
                layout: clone(HOME_LAYOUT),
              });
            case "reset_layout":
              HOME_LAYOUT = {
                ...HOME_LAYOUT,
                itemRevision: HOME_LAYOUT.itemRevision + 1,
                cameraRevision: HOME_LAYOUT.cameraRevision + 1,
                camera: {
                  centerX: 0,
                  centerY: 0,
                  zoomBps: 10000,
                },
                items: [],
              };
              return Promise.resolve({
                ok: true,
                layout: clone(HOME_LAYOUT),
              });

            // ---- Sessions / Misc ----
            case "get_session_window_support":
              return Promise.resolve({
                supported: false,
                reason: "session windows are unavailable in e2e",
              });
            case "list_session_windows":
              return Promise.resolve([]);
            case "plugin:window|is_fullscreen":
              return Promise.resolve(false);
            case "plugin:window|set_min_size":
            case "plugin:window|set_size":
            case "plugin:window|show":
              return Promise.resolve(null);
            case "list_sessions":
              return Promise.resolve(
                ACP_SESSIONS.map((session) => ({
                  sessionId: session.sessionId,
                  title: session.title,
                  updatedAt: session.updatedAt,
                  messageCount: session.messageCount,
                  conversationBefore: session.conversationBefore,
                })),
              );
            case "create_session":
              return Promise.resolve({
                id: "session-" + Math.random().toString(36).slice(2, 10),
                title: "New Chat",
                agentId: args?.agentId ?? null,
                projectId: args?.projectId ?? null,
                providerId: null,
                personaId: null,
                modelName: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                archivedAt: null,
                messageCount: 0,
              });
            case "update_session":
              return Promise.resolve(null);
            case "get_session_messages":
              return Promise.resolve([]);
            case "archive_session":
              return Promise.resolve(null);
            case "list_projects":
              return Promise.resolve(PROJECTS);
            case "get_project":
              return Promise.resolve(PROJECTS.find(p => p.id === args?.id) ?? null);
            case "search_file_mentions":
              return Promise.resolve([]);
            case "get_home_dir":
              return Promise.resolve("/tmp/home");
            case "path_exists":
              return Promise.resolve(false);
            case "read_image_attachment":
              return Promise.resolve({
                base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sU4nS0AAAAASUVORK5CYII=",
                mimeType: "image/png",
              });
            case "resolve_path": {
              const parts = args?.request?.parts ?? [];
              const path = parts
                .filter((part) => typeof part === "string" && part.length > 0)
                .join("/");
              const normalizedPath = path.startsWith("~/")
                ? "/tmp/home/" + path.slice(2)
                : path;
              return Promise.resolve({ path: normalizedPath });
            }
            case "read_agent_source_file": {
              const source = AGENT_SOURCES.find(
                (entry) => entry.path === args?.sourcePath,
              );
              if (!source) {
                return Promise.reject(new Error("agent source not found"));
              }
              return Promise.resolve({
                fileName: String(source.path).split("/").pop() ?? "agent.md",
                fileContents: agentSourceToMarkdown(source),
              });
            }
            case "check_agent_installed":
              return Promise.resolve(
                providerEntries([args?.providerId]).some((entry) => entry.configured),
              );
            case "install_agent":
              if (AGENT_SETUP_FAILURE?.providerId === args?.providerId) {
                for (const line of AGENT_SETUP_FAILURE.lines ?? []) {
                  emitTauriEvent("agent-setup:output", {
                    providerId: args?.providerId,
                    line,
                  });
                }
                return Promise.reject(new Error(AGENT_SETUP_FAILURE.errorMessage));
              }
              return Promise.resolve(null);
            case "authenticate_agent":
              return Promise.resolve(null);
            case "update_agent":
              return Promise.resolve(null);
            case "plugin:event|listen": {
              const eventId = nextEventId++;
              const listeners = EVENT_LISTENERS.get(args?.event) ?? new Map();
              listeners.set(eventId, args?.handler);
              EVENT_LISTENERS.set(args?.event, listeners);
              return Promise.resolve(eventId);
            }
            case "plugin:event|unlisten": {
              EVENT_LISTENERS.get(args?.event)?.delete(args?.eventId);
              return Promise.resolve(null);
            }
            case "plugin:event|emit":
              emitTauriEvent(args?.event, args?.payload);
              return Promise.resolve(null);

            // ---- Fallback ----
            default:
              console.warn("[tauri-mock] unhandled invoke command:", cmd, args);
              return Promise.resolve(null);
          }
        },

        transformCallback(callback, once) {
          const id = nextCallbackId++;
          CALLBACKS.set(id, once ? (...args) => {
            CALLBACKS.delete(id);
            callback(...args);
          } : callback);
          return id;
        },

        unregisterCallback(id) {
          CALLBACKS.delete(id);
        },

        runCallback(id, args) {
          CALLBACKS.get(id)?.(...(Array.isArray(args) ? args : [args]));
        },

        convertFileSrc(path) {
          return path;
        },
      };

      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event, eventId) {
          EVENT_LISTENERS.get(event)?.delete(eventId);
        },
      };
    })();
  `;
}

// ---------------------------------------------------------------------------
// Playwright fixture
// ---------------------------------------------------------------------------

export const test = base.extend<{ tauriMocked: Page }>({
  tauriMocked: async ({ page }, use) => {
    await page.addInitScript({ content: buildInitScript() });
    await use(page);
  },
});

export { expect };

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export async function waitForHome(page: Page) {
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible({
    timeout: 10_000,
  });
}

export async function navigateToAgents(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Agents" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("main")).toBeVisible();
}

export async function navigateToSkills(page: Page) {
  await page.goto("/");
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Skills" }).click();
  await expect(page.locator("h1", { hasText: "Skills" })).toBeVisible();
}
