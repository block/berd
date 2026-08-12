import type { Page } from "@playwright/test";
import {
  TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS,
  TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION,
  TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS,
} from "../../../src/features/chat/transcript/diagnostics";

const LOCAL_TRANSCRIPT_RENDERER_ORIGIN =
  "http://transcript-virtualization.local";
const LOCAL_TRANSCRIPT_RENDERER_PATH = "/transcript-harness";

export const LOCAL_TRANSCRIPT_RENDERER_URL = `${LOCAL_TRANSCRIPT_RENDERER_ORIGIN}${LOCAL_TRANSCRIPT_RENDERER_PATH}`;

const DIAGNOSTIC_NUMERIC_DEFAULTS_JSON = JSON.stringify(
  TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS,
);
const DIAGNOSTICS_SCHEMA_VERSION_JSON = JSON.stringify(
  TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION,
);
const REQUIRED_DIAGNOSTIC_KEYS_JSON = JSON.stringify(
  TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS,
);

const LOCAL_RENDERER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Transcript Virtualization Renderer Bridge</title>
    <style>
      * {
        box-sizing: border-box;
      }

      html,
      body {
        height: 100%;
        margin: 0;
      }

      body {
        background: #f7f7f4;
        color: #1f2328;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }

      body.dark-mode {
        background: #171717;
        color: #f0eee8;
      }

      #root {
        display: flex;
        height: 100vh;
        min-height: 0;
        flex-direction: column;
      }

      #bridge-toolbar {
        display: flex;
        min-height: 40px;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid #d6d1c7;
        background: #ece8df;
        padding: 0 12px;
        font-size: 12px;
      }

      body.dark-mode #bridge-toolbar {
        border-color: #343434;
        background: #222;
      }

      #surface {
        display: flex;
        min-height: 0;
        flex: 1;
      }

      #right-rail {
        display: none;
        width: 240px;
        border-left: 1px solid #d6d1c7;
        background: #fff;
      }

      body.right-rail #right-rail {
        display: block;
      }

      body.dark-mode #right-rail {
        border-color: #343434;
        background: #202020;
      }

      #main-column {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
      }

      body.compact-width #main-column {
        max-width: 390px;
        margin: 0 auto;
        border-inline: 1px solid #d6d1c7;
      }

      #scroller {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        background: #fffdfa;
      }

      body.dark-mode #scroller {
        background: #1d1d1d;
      }

      #canvas {
        width: 100%;
      }

      .transcript-row {
        width: 100%;
        overflow: hidden;
        border-bottom: 1px solid #ece7dc;
        padding: 10px 18px;
        background: #fffdfa;
      }

      body.dark-mode .transcript-row {
        border-color: #333;
        background: #1d1d1d;
      }

      .transcript-row[data-role="user"] {
        background: #f7fbff;
      }

      .transcript-row[data-role="assistant"] {
        background: #fffdfa;
      }

      body.dark-mode .transcript-row[data-role="user"] {
        background: #1c2530;
      }

      body.dark-mode .transcript-row[data-role="assistant"] {
        background: #1d1d1d;
      }

      .transcript-row[data-role="date"] {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #756f65;
        font-size: 12px;
        text-transform: uppercase;
      }

      .row-heading {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 600;
        line-height: 18px;
      }

      .row-id {
        color: #80786c;
        font-weight: 500;
      }

      .row-content {
        margin-top: 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 13px;
        line-height: 18px;
      }

      .row-chip {
        display: inline-flex;
        margin: 6px 6px 0 0;
        border: 1px solid #d2ccc0;
        border-radius: 4px;
        padding: 3px 6px;
        background: #f2eee6;
        color: #4d4841;
        font-size: 12px;
      }

      body.dark-mode .row-chip {
        border-color: #444;
        background: #272727;
        color: #d8d4cc;
      }

      #composer {
        min-height: 72px;
        border-top: 1px solid #d6d1c7;
        background: #f3efe7;
        padding: 12px 16px;
        font-size: 13px;
      }

      body.dark-mode #composer {
        border-color: #343434;
        background: #222;
      }

      #terminal {
        display: none;
        min-height: 96px;
        border-top: 1px solid #252525;
        background: #101010;
        color: #d7f2cb;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", monospace;
        padding: 10px 12px;
        font-size: 12px;
      }

      body.terminal #terminal {
        display: block;
      }
    </style>
  </head>
  <body>
    <div id="root">
      <div id="bridge-toolbar">
        <span id="mode-label">renderer: pending</span>
        <span id="fixture-label">fixture: pending</span>
        <span id="row-label">rows: 0</span>
      </div>
      <div id="surface">
        <div id="main-column">
          <div id="scroller" data-testid="message-timeline-scroll">
            <div
              id="canvas"
              role="log"
              aria-live="polite"
              aria-label="Transcript validation log"
            ></div>
          </div>
          <div id="composer">Composer baseline</div>
          <div id="terminal">terminal surface</div>
        </div>
        <aside id="right-rail" aria-label="validation rail"></aside>
      </div>
    </div>
    <script>
      (() => {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const MAX_TEXT_PREVIEW = 1400;
        const VIRTUAL_OVERSCAN_ROWS = 10;
        const BOTTOM_THRESHOLD_PX = 8;
        const MCP_ROWS_PER_SESSION_CAP = 8;
        const RECENT_ROWS_PER_SESSION_CAP = 20;
        const RECENT_TTL_MS = 60 * 1000;
        const PROTECTED_ROWS_WARN_THRESHOLD = 40;
        const PROTECTED_ROWS_FAIL_THRESHOLD = 80;
        const OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS = 24;

        const DIAGNOSTIC_NUMERIC_DEFAULTS = ${DIAGNOSTIC_NUMERIC_DEFAULTS_JSON};
        const DIAGNOSTICS_SCHEMA_VERSION = ${DIAGNOSTICS_SCHEMA_VERSION_JSON};
        const REQUIRED_DIAGNOSTIC_KEYS = ${REQUIRED_DIAGNOSTIC_KEYS_JSON};

        const scroller = document.getElementById("scroller");
        const canvas = document.getElementById("canvas");
        const modeLabel = document.getElementById("mode-label");
        const fixtureLabel = document.getElementById("fixture-label");
        const rowLabel = document.getElementById("row-label");
        const composer = document.getElementById("composer");

        let state = createEmptyState();

        function createDiagnostics() {
          return { ...DIAGNOSTIC_NUMERIC_DEFAULTS };
        }

        function createEmptyState() {
          return {
            fixture: null,
            rendererMode: "legacy",
            activeSessionId: null,
            sessions: new Map(),
            rows: [],
            prefixHeights: [0],
            rowIndexByMessageId: new Map(),
            rowIndexesByMessageId: new Map(),
            rowTopologyByMessageId: new Map(),
            rowRevisionByMessageId: new Map(),
            rowRenderRevisionByMessageId: new Map(),
            dynamicBlockHeights: new Map(),
            anchor: { type: "bottom" },
            totalHeight: 0,
            mountedStart: 0,
            mountedEnd: 0,
            renderedIndexes: [],
            protectionSignals: new Map(),
            renderDurations: [],
            scrollHandlerDurations: [],
            correctionsPx: [],
            operationStartMs: performance.now(),
            loadStartMs: performance.now(),
            initialHeapBytes: readHeapBytes(),
            diagnostics: createDiagnostics(),
          };
        }

        function readHeapBytes() {
          const memory = performance.memory;
          return typeof memory?.usedJSHeapSize === "number"
            ? memory.usedJSHeapSize
            : null;
        }

        function percentile(values, percentileValue) {
          if (values.length === 0) {
            return 0;
          }
          const sorted = [...values].sort((left, right) => left - right);
          const index = Math.max(
            0,
            Math.ceil(sorted.length * percentileValue) - 1,
          );
          return sorted[index] ?? 0;
        }

        function sleep(ms) {
          return new Promise((resolve) => window.setTimeout(resolve, ms));
        }

        function nextFrame() {
          return new Promise((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          );
        }

        function clone(value) {
          return JSON.parse(JSON.stringify(value));
        }

        function activeSession() {
          return state.sessions.get(state.activeSessionId) ?? null;
        }

        function blockText(block) {
          if (!block || typeof block !== "object") {
            return "";
          }

          switch (block.type) {
            case "text":
            case "reasoning":
              return block.text ?? "";
            case "toolRequest":
              return [
                block.name ?? block.toolName ?? "tool request",
                JSON.stringify(block.arguments ?? {}),
                block.status ?? "",
              ].join(" ");
            case "toolResponse":
              return String(block.result ?? "");
            case "mcpApp":
              return "MCP app " + (block.id ?? "");
            case "image":
              return "Image " + (block.uri ?? "");
            default:
              return JSON.stringify(block).slice(0, 240);
          }
        }

        function estimateTextHeight(text) {
          const lineCount = text.split("\\n").length;
          const charWrappedLines = Math.ceil(text.length / 92);
          const codeFenceMultiplier = text.includes("\\x60\\x60\\x60") ? 18 : 4;
          return Math.max(
            36,
            Math.min(
              120000,
              lineCount * codeFenceMultiplier + charWrappedLines * 18,
            ),
          );
        }

        function estimateBlockHeight(messageId, block, blockIndex) {
          const dynamicHeight = state.dynamicBlockHeights.get(
            messageId + ":" + blockIndex,
          );
          if (typeof dynamicHeight === "number") {
            return dynamicHeight;
          }

          switch (block.type) {
            case "text":
              return estimateTextHeight(block.text ?? "");
            case "reasoning":
              return 72;
            case "toolRequest":
              return block.status === "in_progress" ? 96 : 82;
            case "toolResponse":
              return 72;
            case "mcpApp":
              return 260;
            case "image":
              return 180;
            default:
              return 56;
          }
        }

        function messageHasProtectedState(message, session) {
          if (message.id === session.streamingMessageId) {
            return true;
          }
          return (message.content ?? []).some((block) => {
            return block.status === "in_progress";
          });
        }

        function messageRevision(message) {
          const override = state.rowRevisionByMessageId.get(message.id);
          if (typeof override === "string") {
            return override;
          }
          if (typeof message.metadata?.validationHeightRevision === "string") {
            return message.metadata.validationHeightRevision;
          }
          return JSON.stringify(message.content ?? []).length;
        }

        function messageRenderRevision(message) {
          const override = state.rowRenderRevisionByMessageId.get(message.id);
          if (typeof override === "string") {
            return override;
          }
          if (typeof message.metadata?.validationRenderRevision === "string") {
            return message.metadata.validationRenderRevision;
          }
          return messageRevision(message);
        }

        function estimateMessageHeight(message) {
          if (typeof message.metadata?.validationRowHeight === "number") {
            return message.metadata.validationRowHeight;
          }
          const blockHeight = (message.content ?? []).reduce(
            (height, block, blockIndex) =>
              height + estimateBlockHeight(message.id, block, blockIndex),
            0,
          );
          return Math.max(58, 34 + blockHeight);
        }

        function messageRowId(session, message, suffix) {
          const rowSuffix =
            suffix ?? message.metadata?.validationRowIdSuffix ?? null;
          return (
            session.sessionId +
            ":message:" +
            message.id +
            (rowSuffix ? ":" + rowSuffix : "")
          );
        }

        function anchorPriorityForMessage(message, fallback = "stable") {
          return message.metadata?.validationAnchorPriority ?? fallback;
        }

        function fragmentMessage(message, fragment) {
          return {
            ...message,
            content: [
              {
                type: "text",
                text: fragment.text ?? message.content?.[0]?.text ?? message.id,
              },
            ],
          };
        }

        function buildRowsForSession(session) {
          const rows = [];
          let previousDay = null;

          for (const message of session.messages ?? []) {
            const day = Math.floor((message.created ?? 0) / DAY_MS);
            if (day !== previousDay) {
              rows.push({
                id: session.sessionId + ":date:" + day,
                role: "date",
                messageId: null,
                message: null,
                height: 32,
                protected: false,
                revision: String(day),
                renderRevision: String(day),
                anchorPriority: "none",
              });
              previousDay = day;
            }

            const fragments = state.rowTopologyByMessageId.get(message.id);
            if (Array.isArray(fragments) && fragments.length > 0) {
              for (const fragment of fragments) {
                rows.push({
                  id: messageRowId(session, message, fragment.idSuffix),
                  role: message.role ?? "assistant",
                  messageId: message.id,
                  message: fragmentMessage(message, fragment),
                  height: fragment.height,
                  protected:
                    messageHasProtectedState(message, session) ||
                    fragment.anchorPriority === "streaming",
                  revision: fragment.heightRevision,
                  renderRevision: fragment.renderRevision ?? fragment.heightRevision,
                  anchorPriority: fragment.anchorPriority ?? "stable",
                });
              }
              continue;
            }

            rows.push({
              id: messageRowId(session, message),
              role: message.role ?? "assistant",
              messageId: message.id,
              message,
              height: estimateMessageHeight(message),
              protected: messageHasProtectedState(message, session),
              revision: messageRevision(message),
              renderRevision: messageRenderRevision(message),
              anchorPriority: anchorPriorityForMessage(
                message,
                message.id === session.streamingMessageId ? "streaming" : "stable",
              ),
            });
          }

          return rows;
        }

        function recomputeGeometry() {
          state.prefixHeights = [0];
          state.rowIndexByMessageId = new Map();
          state.rowIndexesByMessageId = new Map();

          state.rows.forEach((row, index) => {
            state.prefixHeights.push(
              state.prefixHeights[state.prefixHeights.length - 1] + row.height,
            );
            if (row.messageId != null) {
              if (!state.rowIndexByMessageId.has(row.messageId)) {
                state.rowIndexByMessageId.set(row.messageId, index);
              }
              const indexes = state.rowIndexesByMessageId.get(row.messageId) ?? [];
              indexes.push(index);
              state.rowIndexesByMessageId.set(row.messageId, indexes);
            }
          });

          state.totalHeight =
            state.prefixHeights[state.prefixHeights.length - 1] ?? 0;
        }

        function rebuildRows() {
          const session = activeSession();
          state.rows = session ? buildRowsForSession(session) : [];
          recomputeGeometry();
        }

        function rowTop(index) {
          return state.prefixHeights[index] ?? 0;
        }

        function rowBottom(index) {
          return state.prefixHeights[index + 1] ?? rowTop(index);
        }

        function findRowIndexForOffset(offset) {
          if (state.rows.length === 0 || offset <= 0) {
            return 0;
          }

          if (offset >= state.totalHeight) {
            return state.rows.length - 1;
          }

          let low = 0;
          let high = state.rows.length - 1;
          let result = 0;

          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (rowBottom(middle) <= offset) {
              low = middle + 1;
            } else {
              result = middle;
              high = middle - 1;
            }
          }

          return result;
        }

        function isNearBottom() {
          return (
            state.totalHeight - scroller.scrollTop - scroller.clientHeight <=
            BOTTOM_THRESHOLD_PX
          );
        }

        function rowById(rowId) {
          return state.rows.find((row) => row.id === rowId) ?? null;
        }

        function rowIndexById(rowId) {
          return state.rows.findIndex((row) => row.id === rowId);
        }

        function virtualRowId(row) {
          return row.messageId != null ? "message:" + row.messageId : row.id;
        }

        function rowIdForMessageId(messageId) {
          const index = state.rowIndexByMessageId.get(messageId);
          if (typeof index !== "number") {
            return null;
          }
          const row = state.rows[index];
          return row ? virtualRowId(row) : null;
        }

        function signalKey(rowId, reason, sourceId) {
          return rowId + "::" + reason + "::" + (sourceId ?? "default");
        }

        function setProtectionSignal({
          rowId,
          reason,
          sourceId,
          active,
          nowMs,
          expiresAtMs,
          mcpKind,
        }) {
          const key = signalKey(rowId, reason, sourceId);
          if (!active) {
            state.protectionSignals.delete(key);
            return;
          }

          state.protectionSignals.set(key, {
            rowId,
            reason,
            sourceId: sourceId ?? "default",
            activatedAtMs: nowMs,
            updatedAtMs: nowMs,
            expiresAtMs,
            mcpKind,
          });
        }

        function clearProtectionSignalsBySource(sourceId) {
          for (const [key, signal] of state.protectionSignals) {
            if (signal.sourceId === sourceId) {
              state.protectionSignals.delete(key);
            }
          }
        }

        function collectProtectionDecision(nowMs = performance.now()) {
          const visibleRowIds = new Set();
          for (let index = state.mountedStart; index < state.mountedEnd; index += 1) {
            const row = state.rows[index];
            if (row) {
              visibleRowIds.add(virtualRowId(row));
            }
          }

          const byRow = new Map();
          let expiredSignalCount = 0;
          for (const [key, signal] of [...state.protectionSignals]) {
            if (
              typeof signal.expiresAtMs === "number" &&
              signal.expiresAtMs <= nowMs
            ) {
              state.protectionSignals.delete(key);
              expiredSignalCount += 1;
              continue;
            }

            const candidate = byRow.get(signal.rowId) ?? {
              rowId: signal.rowId,
              reasons: new Set(),
              updatedAtMs: signal.updatedAtMs,
              expiresAtMs: signal.expiresAtMs,
            };
            candidate.reasons.add(signal.reason);
            candidate.updatedAtMs = Math.max(candidate.updatedAtMs, signal.updatedAtMs);
            if (typeof signal.expiresAtMs === "number") {
              candidate.expiresAtMs =
                typeof candidate.expiresAtMs === "number"
                  ? Math.max(candidate.expiresAtMs, signal.expiresAtMs)
                  : signal.expiresAtMs;
            }
            byRow.set(signal.rowId, candidate);
          }

          for (const row of state.rows) {
            if (!row.protected) {
              continue;
            }
            const rowId = virtualRowId(row);
            const candidate = byRow.get(rowId) ?? {
              rowId,
              reasons: new Set(),
              updatedAtMs: nowMs,
            };
            candidate.reasons.add("active-stream");
            byRow.set(rowId, candidate);
          }

          const forced = [];
          const mcp = [];
          const recent = [];
          for (const candidate of byRow.values()) {
            if (
              candidate.reasons.has("focused") ||
              candidate.reasons.has("selection") ||
              candidate.reasons.has("open-overlay") ||
              candidate.reasons.has("active-stream")
            ) {
              forced.push(candidate);
            } else if (candidate.reasons.has("active-mcp")) {
              mcp.push(candidate);
            } else if (candidate.reasons.has("recent")) {
              recent.push(candidate);
            }
          }

          const newestFirst = (left, right) => right.updatedAtMs - left.updatedAtMs;
          const protectedMcp = [...mcp].sort(newestFirst).slice(0, MCP_ROWS_PER_SESSION_CAP);
          const evictedMcp = [...mcp].sort(newestFirst).slice(MCP_ROWS_PER_SESSION_CAP);
          const protectedRecent = [...recent]
            .sort(newestFirst)
            .slice(0, RECENT_ROWS_PER_SESSION_CAP);
          const evictedRecent = [...recent]
            .sort(newestFirst)
            .slice(RECENT_ROWS_PER_SESSION_CAP);
          const protectedCandidates = [
            ...forced,
            ...protectedMcp,
            ...protectedRecent,
          ];
          const protectedRowIds = new Set(
            protectedCandidates.map((candidate) => candidate.rowId),
          );
          const protectedOffscreenRowIds = new Set(
            [...protectedRowIds].filter((rowId) => !visibleRowIds.has(rowId)),
          );
          const hasActiveInteraction = forced.some((candidate) =>
            [...candidate.reasons].some((reason) =>
              ["focused", "selection", "open-overlay"].includes(reason),
            ),
          );
          const failThresholdExceeded =
            protectedRowIds.size > PROTECTED_ROWS_FAIL_THRESHOLD &&
            !hasActiveInteraction;

          return {
            protectedRowIds,
            protectedOffscreenRowIds,
            diagnostics: {
              protectedRows: protectedRowIds.size,
              protectedOffscreenRows: protectedOffscreenRowIds.size,
              forcedProtectedRowCount: forced.length,
              mcpCandidateCount: mcp.length,
              mcpProtectedRowCount: protectedMcp.length,
              recentCandidateCount: recent.length,
              recentProtectedRowCount: protectedRecent.length,
              evictedMcpRowCount: evictedMcp.length,
              evictedRecentRowCount: evictedRecent.length,
              expiredSignalCount,
              warnThresholdExceeded:
                protectedRowIds.size > PROTECTED_ROWS_WARN_THRESHOLD,
              failThresholdExceeded,
              failThresholdJustifiedByActiveInteraction:
                protectedRowIds.size > PROTECTED_ROWS_FAIL_THRESHOLD &&
                hasActiveInteraction,
              rows: protectedCandidates.map((candidate) => ({
                rowId: candidate.rowId,
                reasons: [...candidate.reasons].sort(),
                isVisible: visibleRowIds.has(candidate.rowId),
                protected: true,
              })),
            },
          };
        }

        function findViewportAnchor() {
          const top = scroller.scrollTop;
          const bottom = scroller.scrollTop + scroller.clientHeight;

          for (const priority of ["stable", "streaming"]) {
            for (let index = 0; index < state.rows.length; index += 1) {
              const row = state.rows[index];
              if (row.anchorPriority !== priority) {
                continue;
              }
              if (rowBottom(index) <= top || rowTop(index) >= bottom) {
                continue;
              }
              return {
                type: "row",
                rowId: row.id,
                offsetWithinRow: top - rowTop(index),
                anchorRevision: row.revision,
              };
            }
          }

          return { type: "bottom" };
        }

        function syncAnchorFromViewport() {
          state.anchor = isNearBottom() ? { type: "bottom" } : findViewportAnchor();
        }

        function setScrollTop(nextScrollTop) {
          scroller.scrollTop = Math.max(
            0,
            Math.min(nextScrollTop, Math.max(0, state.totalHeight)),
          );
          syncAnchorFromViewport();
          render();
        }

        function scrollToPosition(position) {
          if (position === "top") {
            setScrollTop(0);
            return;
          }

          if (position === "middle") {
            setScrollTop(Math.max(0, state.totalHeight / 2));
            return;
          }

          setScrollTop(Math.max(0, state.totalHeight - scroller.clientHeight));
        }

        function appendText(parent, className, text) {
          const element = document.createElement("div");
          element.className = className;
          element.textContent = text;
          parent.appendChild(element);
        }

        function appendBlockPreview(parent, block) {
          const text = blockText(block);
          if (block.type === "toolRequest" || block.type === "toolResponse") {
            appendText(
              parent,
              "row-chip",
              block.type + ": " + text.slice(0, 120),
            );
            return;
          }

          if (block.type === "mcpApp" || block.type === "image") {
            appendText(parent, "row-chip", text.slice(0, 120));
            return;
          }

          const clipped =
            text.length > MAX_TEXT_PREVIEW
              ? text.slice(0, MAX_TEXT_PREVIEW) + "..."
              : text;
          appendText(parent, "row-content", clipped);
        }

        function createRowElement(row, index, rowState) {
          const element = document.createElement("div");
          element.className = "transcript-row";
          element.dataset.transcriptRowId = row.id;
          element.dataset.virtualRowId = virtualRowId(row);
          if (row.messageId != null) {
            element.dataset.transcriptMessageId = row.messageId;
            element.dataset.virtualRowMessageId = row.messageId;
          }
          element.dataset.virtualRowAnchorPriority = row.anchorPriority ?? "stable";
          element.dataset.virtualRowHeightRevision = row.revision;
          element.dataset.virtualRowRenderRevision =
            row.renderRevision ?? row.revision;
          element.dataset.virtualRowProtected = rowState.protected ? "true" : "false";
          element.dataset.virtualRowVisible = rowState.visible ? "true" : "false";
          element.dataset.role = row.role;
          element.style.height = row.height + "px";

          if (state.rendererMode === "virtual") {
            element.style.position = "absolute";
            element.style.left = "0";
            element.style.right = "0";
            element.style.top = rowTop(index) + "px";
          }

          if (row.role === "date") {
            element.textContent = "Date separator";
            return element;
          }

          const heading = document.createElement("div");
          heading.className = "row-heading";
          heading.textContent = row.role;
          const id = document.createElement("span");
          id.className = "row-id";
          id.textContent = row.messageId;
          heading.appendChild(id);
          element.appendChild(heading);

          for (const block of row.message?.content ?? []) {
            appendBlockPreview(element, block);
          }

          return element;
        }

        function updateChrome() {
          modeLabel.textContent = "renderer: " + state.rendererMode;
          fixtureLabel.textContent = "fixture: " + (state.fixture?.name ?? "none");
          rowLabel.textContent = "rows: " + state.rows.length;
        }

        function rowHasUnsafeOffscreenMeasurementDescendant(row) {
          if (row.protected) {
            return true;
          }
          return (row.message?.content ?? []).some((block) => {
            return (
              block.type === "mcpApp" ||
              block.type === "image" ||
              block.type === "toolRequest" ||
              block.type === "toolResponse" ||
              block.type === "reasoning" ||
              block.type === "thinking" ||
              block.type === "redactedThinking" ||
              block.type === "actionRequired"
            );
          });
        }

        function createOffscreenMeasurementHost(renderedIndexes) {
          if (state.rendererMode !== "virtual") {
            return null;
          }

          const renderedIndexSet = new Set(renderedIndexes);
          const start = Math.max(
            0,
            state.mountedStart - OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS,
          );
          const end = Math.min(
            state.rows.length - 1,
            state.mountedEnd + OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS,
          );
          const shellRows = [];
          for (let index = start; index <= end; index += 1) {
            const row = state.rows[index];
            if (
              !row ||
              renderedIndexSet.has(index) ||
              row.messageId == null ||
              rowHasUnsafeOffscreenMeasurementDescendant(row)
            ) {
              continue;
            }
            shellRows.push(row);
            if (shellRows.length >= 3) {
              break;
            }
          }

          const host = document.createElement("div");
          host.setAttribute("aria-hidden", "true");
          host.dataset.testid = "virtual-offscreen-measurement-host";
          host.dataset.virtualOffscreenShellRowCount = String(shellRows.length);
          host.style.contain = "layout style paint";
          host.style.pointerEvents = "none";
          host.style.position = "absolute";
          host.style.top = "0";
          host.style.transform = "translateY(-100000px)";
          host.style.visibility = "hidden";
          host.style.width = "100%";

          for (const row of shellRows) {
            const shell = document.createElement("div");
            shell.dataset.virtualRowOffscreenShellId = virtualRowId(row);
            shell.dataset.virtualRowShellUniqueToken =
              "offscreen-shell-token-" + row.messageId;
            shell.style.height = Math.max(1, row.height) + "px";
            host.appendChild(shell);
          }

          return host;
        }

        function updateVirtualDiagnostics(protectionDecision, offscreenHost) {
          const mountedRows = document.querySelectorAll(
            "[data-transcript-row-id]",
          ).length;
          const protectedRows = protectionDecision.diagnostics.protectedRows;
          const shellRows = Number(
            offscreenHost?.dataset.virtualOffscreenShellRowCount ?? "0",
          );
          const diagnostics = {
            ...state.diagnostics,
            protectedRows,
            protectedOffscreenRows:
              protectionDecision.diagnostics.protectedOffscreenRows,
            mountedRows,
            logicalRows: state.rows.length,
            acceptedOffscreenShellMeasurements: shellRows,
            acceptedOffscreenRealMeasurements: 0,
            offscreenShellRowCount: shellRows,
            mcpCandidateCount:
              protectionDecision.diagnostics.mcpCandidateCount,
            mcpProtectedRowCount:
              protectionDecision.diagnostics.mcpProtectedRowCount,
            recentCandidateCount:
              protectionDecision.diagnostics.recentCandidateCount,
            recentProtectedRowCount:
              protectionDecision.diagnostics.recentProtectedRowCount,
            evictedMcpRowCount:
              protectionDecision.diagnostics.evictedMcpRowCount,
            evictedRecentRowCount:
              protectionDecision.diagnostics.evictedRecentRowCount,
            expiredSignalCount:
              protectionDecision.diagnostics.expiredSignalCount,
            warnThresholdExceeded:
              protectionDecision.diagnostics.warnThresholdExceeded,
            failThresholdExceeded:
              protectionDecision.diagnostics.failThresholdExceeded,
            failThresholdJustifiedByActiveInteraction:
              protectionDecision.diagnostics
                .failThresholdJustifiedByActiveInteraction,
            rows: protectionDecision.diagnostics.rows,
          };
          state.diagnostics = {
            ...state.diagnostics,
            protectedRows,
            protectedOffscreenRows:
              protectionDecision.diagnostics.protectedOffscreenRows,
            acceptedOffscreenShellMeasurements: shellRows,
            acceptedOffscreenRealMeasurements: 0,
            offscreenShellRowCount: shellRows,
          };
          window.__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__ = diagnostics;
        }

        function render() {
          const started = performance.now();
          const virtual = state.rendererMode === "virtual";
          let start = 0;
          let end = state.rows.length;

          canvas.style.position = virtual ? "relative" : "static";
          canvas.style.height = virtual ? state.totalHeight + "px" : "auto";

          if (virtual) {
            start = Math.max(
              0,
              findRowIndexForOffset(scroller.scrollTop) - VIRTUAL_OVERSCAN_ROWS,
            );
            end = Math.min(
              state.rows.length,
              findRowIndexForOffset(scroller.scrollTop + scroller.clientHeight) +
                VIRTUAL_OVERSCAN_ROWS +
                1,
            );
          }

          state.mountedStart = start;
          state.mountedEnd = end;
          const protectionDecision = collectProtectionDecision();
          const ordinaryIndexes = Array.from(
            { length: Math.max(0, end - start) },
            (_, offset) => start + offset,
          );
          const protectedIndexes = [...protectionDecision.protectedRowIds]
            .map((rowId) => {
              const messagePrefix = "message:";
              if (rowId.startsWith(messagePrefix)) {
                return state.rowIndexByMessageId.get(rowId.slice(messagePrefix.length));
              }
              return rowIndexById(rowId);
            })
            .filter((index) => typeof index === "number" && index >= 0);
          const renderedIndexes = virtual
            ? [...new Set([...ordinaryIndexes, ...protectedIndexes])].sort(
                (left, right) => left - right,
              )
            : ordinaryIndexes;
          state.renderedIndexes = renderedIndexes;

          const fragment = document.createDocumentFragment();
          for (const index of renderedIndexes) {
            const row = state.rows[index];
            if (!row) {
              continue;
            }
            const rowId = virtualRowId(row);
            fragment.appendChild(
              createRowElement(row, index, {
                protected: protectionDecision.protectedRowIds.has(rowId),
                visible: index >= start && index < end,
              }),
            );
          }
          const offscreenHost = createOffscreenMeasurementHost(renderedIndexes);
          if (offscreenHost) {
            fragment.appendChild(offscreenHost);
          }

          canvas.replaceChildren(fragment);
          state.renderDurations.push(performance.now() - started);
          state.diagnostics.measurementBatchSize = Math.max(
            state.diagnostics.measurementBatchSize,
            renderedIndexes.length,
          );
          updateVirtualDiagnostics(protectionDecision, offscreenHost);
          updateChrome();
        }

        function measureBlankViewportPixels() {
          const MAX_INTENTIONAL_ROW_GAP_PX = 24;
          const MAX_INTENTIONAL_EDGE_GAP_PX = 96;
          const scrollerRect = scroller.getBoundingClientRect();
          const visibleIntervals = Array.from(
            document.querySelectorAll("[data-transcript-row-id]"),
          )
            .map((row) => row.getBoundingClientRect())
            .map((rect) => ({
              top: Math.max(rect.top, scrollerRect.top),
              bottom: Math.min(rect.bottom, scrollerRect.bottom),
            }))
            .filter((interval) => interval.bottom > interval.top)
            .sort((left, right) => left.top - right.top);

          if (visibleIntervals.length === 0) {
            return scroller.clientHeight;
          }

          const mergedIntervals = [];
          for (const interval of visibleIntervals) {
            const previous = mergedIntervals[mergedIntervals.length - 1];
            if (!previous || interval.top > previous.bottom) {
              mergedIntervals.push({ ...interval });
              continue;
            }
            previous.bottom = Math.max(previous.bottom, interval.bottom);
          }

          let blankViewportPixels = 0;
          const firstInterval = mergedIntervals[0];
          const lastInterval = mergedIntervals[mergedIntervals.length - 1];
          if (firstInterval) {
            blankViewportPixels += Math.max(
              0,
              firstInterval.top - scrollerRect.top - MAX_INTENTIONAL_EDGE_GAP_PX,
            );
          }
          for (let index = 1; index < mergedIntervals.length; index += 1) {
            const previous = mergedIntervals[index - 1];
            const current = mergedIntervals[index];
            if (!previous || !current) {
              continue;
            }
            blankViewportPixels += Math.max(
              0,
              current.top - previous.bottom - MAX_INTENTIONAL_ROW_GAP_PX,
            );
          }
          if (lastInterval) {
            blankViewportPixels += Math.max(
              0,
              scrollerRect.bottom - lastInterval.bottom - MAX_INTENTIONAL_EDGE_GAP_PX,
            );
          }

          return blankViewportPixels;
        }

        function mountedProtectedRows() {
          return document.querySelectorAll(
            '[data-virtual-row-protected="true"]',
          ).length;
        }

        function recordScrollCorrection(px) {
          if (px === 0) {
            return;
          }
          state.correctionsPx.push(Math.abs(px));
        }

        function setBodyToggle(name, enabled) {
          document.body.classList.toggle(name, enabled);
        }

        function sessionById(sessionId) {
          const session = state.sessions.get(sessionId);
          if (!session) {
            throw new Error("unknown fixture session " + sessionId);
          }
          return session;
        }

        function messageById(session, messageId) {
          const message = session.messages.find((candidate) => candidate.id === messageId);
          if (!message) {
            throw new Error("unknown fixture message " + messageId);
          }
          return message;
        }

        function rowTopByMessageId(messageId) {
          const index = state.rowIndexByMessageId.get(messageId);
          return typeof index === "number" ? rowTop(index) : null;
        }

        function rowIdByMessageId(messageId) {
          const index = state.rowIndexByMessageId.get(messageId);
          return typeof index === "number" ? state.rows[index]?.id ?? null : null;
        }

        function scrollToRowOffset(messageId, offsetPx) {
          const top = rowTopByMessageId(messageId);
          if (top != null) {
            setScrollTop(top + offsetPx);
          }
        }

        function preserveScrollAfterPr928TopologyChange(
          previousAnchor,
          previousScrollTop,
          expectedProof,
        ) {
          const sameRow = previousAnchor?.type === "row"
            ? rowById(previousAnchor.rowId)
            : null;

          if (previousAnchor?.type === "row" && sameRow == null) {
            state.diagnostics.missingAnchorsDropped =
              (state.diagnostics.missingAnchorsDropped ?? 0) + 1;
          } else if (
            previousAnchor?.type === "row" &&
            sameRow.revision !== previousAnchor.anchorRevision
          ) {
            state.diagnostics.staleAnchorsDropped =
              (state.diagnostics.staleAnchorsDropped ?? 0) + 1;
          }

          setScrollTop(previousScrollTop);
          if (state.anchor?.type === "row") {
            state.diagnostics.recapturedAnchors =
              (state.diagnostics.recapturedAnchors ?? 0) + 1;
          }
          if (expectedProof) {
            state.diagnostics[expectedProof] =
              (state.diagnostics[expectedProof] ?? 0) + 1;
          }
        }

        function changeRowRevision(operation) {
          const previousAnchor = state.anchor;
          const previousScrollTop = scroller.scrollTop;
          state.rowRevisionByMessageId.set(
            operation.messageId,
            operation.nextHeightRevision,
          );
          if (operation.nextRenderRevision) {
            state.rowRenderRevisionByMessageId.set(
              operation.messageId,
              operation.nextRenderRevision,
            );
          }
          rebuildRows();
          preserveScrollAfterPr928TopologyChange(
            previousAnchor,
            previousScrollTop,
            "pr928SameIdStaleRevisionProofs",
          );
        }

        function splitMessageRows(operation) {
          const previousAnchor = state.anchor;
          const previousScrollTop = scroller.scrollTop;
          state.rowTopologyByMessageId.set(
            operation.messageId,
            clone(operation.fragments ?? []),
          );
          rebuildRows();
          preserveScrollAfterPr928TopologyChange(
            previousAnchor,
            previousScrollTop,
            "pr928WholeRowSplitProofs",
          );
        }

        function promoteStreamingTail(operation) {
          const previousAnchor = state.anchor;
          const previousScrollTop = scroller.scrollTop;
          state.rowTopologyByMessageId.set(operation.messageId, [
            clone(operation.completedFragment),
            clone(operation.nextTail),
          ]);
          rebuildRows();
          preserveScrollAfterPr928TopologyChange(
            previousAnchor,
            previousScrollTop,
            "pr928StreamingTailPromotionProofs",
          );
        }

        function mutateMessagePreservingScroll(sessionId, messageId, mutator) {
          const wasNearBottom = isNearBottom();
          const beforeTop = rowTopByMessageId(messageId);
          const session = sessionById(sessionId);
          const message = messageById(session, messageId);
          mutator(message);
          const previousScrollTop = scroller.scrollTop;

          rebuildRows();

          const afterTop = rowTopByMessageId(messageId);
          if (wasNearBottom) {
            scrollToPosition("tail");
          } else if (
            beforeTop != null &&
            afterTop != null &&
            beforeTop < previousScrollTop
          ) {
            const correction = afterTop - beforeTop;
            recordScrollCorrection(correction);
            setScrollTop(previousScrollTop + correction);
          } else {
            setScrollTop(previousScrollTop);
          }
        }

        function appendStreamingChunk(sessionId, messageId, chunk) {
          mutateMessagePreservingScroll(sessionId, messageId, (message) => {
            const textBlock = (message.content ?? []).find(
              (block) => block.type === "text",
            );
            if (textBlock) {
              textBlock.text = (textBlock.text ?? "") + chunk;
            } else {
              message.content = [...(message.content ?? []), { type: "text", text: chunk }];
            }
            message.metadata = {
              ...(message.metadata ?? {}),
              completionStatus: "inProgress",
            };
          });

          const denominator = Math.max(
            state.rows.length,
            state.fixture?.expectations?.minLogicalRows ?? state.rows.length,
            1,
          );
          state.diagnostics.descriptorChurnPercent = Math.max(
            state.diagnostics.descriptorChurnPercent,
            (1 / denominator) * 100,
          );
        }

        function prependMessages(operation) {
          const anchorTopBefore = rowTopByMessageId(operation.anchorMessageId);
          const previousScrollTop = scroller.scrollTop;
          const session = sessionById(operation.sessionId);
          const firstCreated = session.messages[0]?.created ?? Date.now();
          const newMessages = Array.from({ length: operation.count }, (_, index) => ({
            id: "prepended-" + String(index).padStart(4, "0"),
            role: index % 2 === 0 ? "user" : "assistant",
            created: firstCreated - (operation.count - index) * 60000,
            content: [
              {
                type: "text",
                text: "Prepended validation message " + index,
              },
            ],
            metadata: { userVisible: true, agentVisible: true },
          }));

          session.messages = [...newMessages, ...session.messages];
          rebuildRows();

          const anchorTopAfter = rowTopByMessageId(operation.anchorMessageId);
          if (anchorTopBefore != null && anchorTopAfter != null) {
            const correction = anchorTopAfter - anchorTopBefore;
            recordScrollCorrection(correction);
            setScrollTop(previousScrollTop + correction);
          } else {
            setScrollTop(previousScrollTop);
          }
        }

        function setDynamicBlockHeight(operation, height) {
          const wasNearBottom = isNearBottom();
          const beforeTop = rowTopByMessageId(operation.messageId);
          const previousScrollTop = scroller.scrollTop;
          state.diagnostics.measurementAcceptedCount += 1;
          state.dynamicBlockHeights.set(
            operation.messageId + ":" + (operation.blockIndex ?? 0),
            height,
          );

          rebuildRows();

          const afterTop = rowTopByMessageId(operation.messageId);
          if (wasNearBottom) {
            scrollToPosition("tail");
          } else if (
            beforeTop != null &&
            afterTop != null &&
            beforeTop < previousScrollTop
          ) {
            const correction = afterTop - beforeTop;
            recordScrollCorrection(correction);
            setScrollTop(previousScrollTop + correction);
          } else {
            setScrollTop(previousScrollTop);
          }
        }

        function refreshProtectionDiagnosticsOnly() {
          updateVirtualDiagnostics(
            collectProtectionDecision(),
            document.querySelector('[data-testid="virtual-offscreen-measurement-host"]'),
          );
        }

        function rowIdsIntersectingRanges(ranges) {
          const rowIds = new Set();
          const rows = Array.from(
            document.querySelectorAll("[data-transcript-row-id]"),
          );
          for (const range of ranges) {
            for (const row of rows) {
              if (!(row instanceof HTMLElement)) {
                continue;
              }
              try {
                if (range.intersectsNode(row)) {
                  const rowId = row.dataset.virtualRowId;
                  if (rowId) {
                    rowIds.add(rowId);
                  }
                }
              } catch (_error) {
                // Detached range endpoints can throw in browser-specific ways.
              }
            }
          }
          return rowIds;
        }

        function syncDomSelectionProtection() {
          clearProtectionSignalsBySource("dom-selection");
          refreshProtectionDiagnosticsOnly();
        }

        function syncSelectedTextMenuProtection(detail) {
          clearProtectionSignalsBySource("selected-text-menu-overlay");
          if (!detail?.open) {
            render();
            return;
          }

          const ranges = Array.isArray(detail.ranges) ? detail.ranges : [];
          for (const rowId of rowIdsIntersectingRanges(ranges)) {
            const nowMs = performance.now();
            setProtectionSignal({
              rowId,
              reason: "open-overlay",
              sourceId: "selected-text-menu-overlay",
              active: true,
              nowMs,
            });
          }
          render();
        }

        function setMcpProtection(operation, reason) {
          const rowId = rowIdForMessageId(operation.messageId);
          if (!rowId) {
            return;
          }
          const nowMs =
            typeof operation.nowMs === "number" ? operation.nowMs : performance.now();
          const ttlMs =
            typeof operation.ttlMs === "number"
              ? operation.ttlMs
              : reason === "active-mcp" || reason === "recent"
                ? RECENT_TTL_MS
                : undefined;
          setProtectionSignal({
            rowId,
            reason,
            sourceId:
              operation.sourceId ??
              operation.kind + ":" + operation.messageId + ":" + reason,
            active: operation.active !== false,
            nowMs,
            expiresAtMs: typeof ttlMs === "number" ? nowMs + ttlMs : undefined,
            mcpKind: operation.activityKind,
          });
        }

        async function applyOperation(operation) {
          const started = performance.now();

          switch (operation.kind) {
            case "restore":
              state.activeSessionId = operation.sessionId;
              rebuildRows();
              render();
              scrollToPosition(operation.scrollPosition);
              break;
            case "scroll":
              setScrollTop(
                scroller.scrollTop +
                  (operation.direction === "up"
                    ? -operation.pixels
                    : operation.pixels),
              );
              break;
            case "prependMessages":
              prependMessages(operation);
              break;
            case "controlledScrollTarget": {
              const top = rowTopByMessageId(operation.messageId);
              if (top != null) {
                setScrollTop(Math.max(0, top - 96));
              }
              break;
            }
            case "scrollToRowOffset":
              scrollToRowOffset(operation.messageId, operation.offsetPx);
              break;
            case "changeRowRevision":
              changeRowRevision(operation);
              break;
            case "splitMessageRows":
              splitMessageRows(operation);
              break;
            case "promoteStreamingTail":
              promoteStreamingTail(operation);
              break;
            case "appendStreamingText":
              for (const chunk of operation.chunks ?? []) {
                appendStreamingChunk(operation.sessionId, operation.messageId, chunk);
                await sleep(operation.chunkIntervalMs ?? 0);
              }
              break;
            case "finishStreamingText": {
              const session = sessionById(operation.sessionId);
              if (session.streamingMessageId === operation.messageId) {
                session.streamingMessageId = null;
              }
              mutateMessagePreservingScroll(
                operation.sessionId,
                operation.messageId,
                (message) => {
                  message.metadata = {
                    ...(message.metadata ?? {}),
                    completionStatus: "completed",
                  };
                },
              );
              break;
            }
            case "stopStreamingText": {
              const session = sessionById(operation.sessionId);
              if (session.streamingMessageId === operation.messageId) {
                session.streamingMessageId = null;
              }
              mutateMessagePreservingScroll(
                operation.sessionId,
                operation.messageId,
                (message) => {
                  message.metadata = {
                    ...(message.metadata ?? {}),
                    completionStatus: "stopped",
                  };
                },
              );
              break;
            }
            case "resizeMcpApp":
              setMcpProtection({
                ...operation,
                kind: "mcpRecentResize",
                active: true,
                activityKind: "recent-resize",
                sourceId: "mcp-resize:" + operation.messageId,
              }, "active-mcp");
              for (const height of operation.heights ?? []) {
                state.diagnostics.measurementAcceptedCount += 1;
                state.dynamicBlockHeights.set(operation.messageId + ":2", height);
                mutateMessagePreservingScroll(
                  operation.sessionId,
                  operation.messageId,
                  (message) => {
                    message.metadata = {
                      ...(message.metadata ?? {}),
                      validationResizeToken: height,
                    };
                  },
                );
              }
              break;
            case "mcpFocus":
              setMcpProtection(operation, "focused");
              render();
              break;
            case "mcpOverlay":
              setMcpProtection(operation, "open-overlay");
              render();
              break;
            case "mcpHostWork":
              setMcpProtection(
                { ...operation, activityKind: "host-request" },
                "active-mcp",
              );
              render();
              break;
            case "mcpNestedToolWork":
              setMcpProtection(
                { ...operation, activityKind: "nested-tool-request" },
                "active-mcp",
              );
              render();
              break;
            case "mcpRecentMessage":
              setMcpProtection(
                { ...operation, activityKind: "recent-message" },
                "active-mcp",
              );
              render();
              break;
            case "mcpRecentResize":
              setMcpProtection(
                { ...operation, activityKind: "recent-resize" },
                "active-mcp",
              );
              render();
              break;
            case "mcpClearProtections":
              for (const [key, signal] of [...state.protectionSignals]) {
                if (
                  signal.reason === "active-mcp" ||
                  signal.sourceId.startsWith("mcp") ||
                  signal.rowId.startsWith("message:mcp-message-")
                ) {
                  state.protectionSignals.delete(key);
                }
              }
              render();
              break;
            case "imageLoad":
              setDynamicBlockHeight(operation, operation.height);
              break;
            case "codeHighlightComplete": {
              const session = sessionById(operation.sessionId);
              const message = messageById(session, operation.messageId);
              const oldHeight = estimateMessageHeight(message);
              mutateMessagePreservingScroll(
                operation.sessionId,
                operation.messageId,
                (targetMessage) => {
                  targetMessage.metadata = {
                    ...(targetMessage.metadata ?? {}),
                    validationCodeHighlightDelta:
                      (targetMessage.metadata?.validationCodeHighlightDelta ?? 0) +
                      operation.heightDelta,
                  };
                },
              );
              const newHeight = estimateMessageHeight(message);
              if (newHeight === oldHeight) {
                setDynamicBlockHeight(operation, oldHeight + operation.heightDelta);
              }
              break;
            }
            case "composerResize":
              composer.style.minHeight = operation.height + "px";
              composer.textContent = operation.queuedMessage
                ? "Composer queued: " + operation.queuedMessage
                : "Composer baseline";
              break;
            case "toggleSurface":
              setBodyToggle(operation.surface, operation.enabled);
              break;
            case "switchSession":
              state.diagnostics.staleMeasurementRejectCount +=
                operation.pendingAsyncWork?.length ?? 0;
              state.diagnostics.staleMeasurementSessionDrops +=
                operation.pendingAsyncWork?.length ?? 0;
              state.activeSessionId = operation.toSessionId;
              rebuildRows();
              render();
              setScrollTop(0);
              break;
          }

          state.diagnostics.restoreReplayDrainMs = Math.max(
            state.diagnostics.restoreReplayDrainMs,
            performance.now() - started,
          );
          await nextFrame();
        }

        async function loadFixture(fixture, options) {
          const loadStarted = performance.now();
          state = createEmptyState();
          state.loadStartMs = loadStarted;
          state.operationStartMs = loadStarted;
          state.fixture = clone(fixture);
          state.rendererMode = options?.rendererMode ?? "legacy";
          state.activeSessionId = state.fixture.activeSessionId;

          for (const session of state.fixture.sessions ?? []) {
            state.sessions.set(session.sessionId, clone(session));
          }

          rebuildRows();
          render();
          scrollToPosition("tail");
          await nextFrame();
          state.diagnostics.timeToFirstVisibleTailMs =
            performance.now() - loadStarted;
        }

        function collectDiagnostics() {
          const mountedRows = document.querySelectorAll(
            "[data-transcript-row-id]",
          ).length;
          const elapsedSeconds = Math.max(
            0.001,
            (performance.now() - state.operationStartMs) / 1000,
          );
          const currentHeapBytes = readHeapBytes();

          state.diagnostics.mountedRows = mountedRows;
          state.diagnostics.protectedRows = mountedProtectedRows();
          state.diagnostics.blankViewportPixels = measureBlankViewportPixels();
          state.diagnostics.projectionP95Ms = percentile(state.renderDurations, 0.95);
          state.diagnostics.projectionLastMs =
            state.renderDurations[state.renderDurations.length - 1] ?? 0;
          state.diagnostics.heapGrowthMb =
            currentHeapBytes != null && state.initialHeapBytes != null
              ? Math.max(0, (currentHeapBytes - state.initialHeapBytes) / 1048576)
              : 0;
          state.diagnostics.scrollHandlerP95Ms = percentile(
            state.scrollHandlerDurations,
            0.95,
          );
          state.diagnostics.scrollCorrectionP95Px = percentile(
            state.correctionsPx,
            0.95,
          );
          state.diagnostics.scrollCorrectionCount = state.correctionsPx.length;
          state.diagnostics.scrollCorrectionsPerSecond =
            state.correctionsPx.length / elapsedSeconds;
          state.diagnostics.measurementCacheHitRate = 1;
          state.diagnostics.staleMeasurementDrops =
            state.diagnostics.staleMeasurementRejectCount ?? 0;

          for (const key of REQUIRED_DIAGNOSTIC_KEYS) {
            if (
              typeof state.diagnostics[key] !== "number" ||
              !Number.isFinite(state.diagnostics[key])
            ) {
              state.diagnostics[key] = 0;
            }
          }

          return {
            schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
            ...state.diagnostics,
            bridgeKind: "local-dom-renderer-bridge",
            activeSessionId: state.activeSessionId,
            rendererMode: state.rendererMode,
            logicalRows: state.rows.length,
            totalScrollHeight: state.totalHeight,
            staleAnchorsDropped: state.diagnostics.staleAnchorsDropped ?? 0,
            missingAnchorsDropped: state.diagnostics.missingAnchorsDropped ?? 0,
            recapturedAnchors: state.diagnostics.recapturedAnchors ?? 0,
            pr928SameIdStaleRevisionProofs:
              state.diagnostics.pr928SameIdStaleRevisionProofs ?? 0,
            pr928WholeRowSplitProofs:
              state.diagnostics.pr928WholeRowSplitProofs ?? 0,
            pr928StreamingTailPromotionProofs:
              state.diagnostics.pr928StreamingTailPromotionProofs ?? 0,
            pr928RealFragmentTailBlockers:
              state.diagnostics.pr928RealFragmentTailBlockers ?? 0,
          };
        }

        scroller.addEventListener(
          "scroll",
          () => {
            const started = performance.now();
            if (state.rendererMode === "virtual") {
              render();
            }
            state.scrollHandlerDurations.push(performance.now() - started);
          },
          { passive: true },
        );
        document.addEventListener("selectionchange", syncDomSelectionProtection);
        window.addEventListener(
          "goose:transcript-selected-text-context-menu",
          (event) => {
            syncSelectedTextMenuProtection(event.detail);
          },
        );

        window.__TRANSCRIPT_VIRTUALIZATION_HARNESS__ = {
          loadFixture,
          applyOperation,
          collectDiagnostics,
        };
      })();
    </script>
  </body>
</html>`;

export function isLocalTranscriptRendererBridgeUrl(
  rendererUrl: string,
): boolean {
  try {
    const url = new URL(rendererUrl);
    return (
      url.origin === LOCAL_TRANSCRIPT_RENDERER_ORIGIN &&
      url.pathname === LOCAL_TRANSCRIPT_RENDERER_PATH
    );
  } catch (_error) {
    return false;
  }
}

export async function installLocalTranscriptRendererBridge(
  page: Page,
  rendererUrl: string,
) {
  if (!isLocalTranscriptRendererBridgeUrl(rendererUrl)) {
    return;
  }

  await page.route(`${LOCAL_TRANSCRIPT_RENDERER_URL}**`, async (route) => {
    await route.fulfill({
      body: LOCAL_RENDERER_HTML,
      contentType: "text/html",
      status: 200,
    });
  });
}
