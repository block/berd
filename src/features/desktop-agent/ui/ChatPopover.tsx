// Desktop-agent chat popover: transcript list, grouped tool activity,
// scoped markdown for assistant replies, and the composer. User text
// stays verbatim in display; wire-only preambles are stripped during
// replay by transcriptDisplay. All user-facing strings live in the
// `desktop-agent` i18n namespace.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  plainText,
  type ChatMessage,
  type ToolActivity,
} from "../lib/chatModels";
import { deriveComposerHint } from "../lib/composerHint";
import { chooseComposerSendSource, perchSendPreamble } from "../lib/sendSource";
import {
  groupTranscript,
  stripWirePreamble,
  toolDisplayName,
  toolGlyph,
  toolResultText,
} from "../lib/transcriptDisplay";
import { MarkdownBody } from "./MarkdownBody";
import type { PerchView } from "../hooks/usePerch";
import type { SessionView } from "../hooks/useSession";

/** Consecutive tool-only messages, collapsed to one quiet summary line —
 *  a replayed agent session would otherwise render dozens of tool rows
 *  drowning the conversation. Click expands the individual calls;
 *  failures are surfaced in the summary. */
function ToolRunRow({ tools }: { tools: ToolActivity[] }) {
  const { t } = useTranslation("desktop-agent");
  const [expanded, setExpanded] = useState(false);
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const running = tools.some(
    (tool) => tool.status !== "completed" && tool.status !== "failed",
  );
  const summary = running
    ? `⚙ ${t("tools.working", { count: tools.length })}`
    : `⚙ ${t("tools.summary", { count: tools.length })}${
        failed > 0 ? ` · ${t("tools.failed", { count: failed })}` : ""
      }`;
  return (
    <div className="row assistant">
      <button
        type="button"
        className={`tool-run-summary ${failed > 0 ? "has-failures" : ""}`}
        onClick={() => setExpanded((open) => !open)}
        title={expanded ? t("tools.collapse") : t("tools.expand")}
      >
        <span className={`disclosure ${expanded ? "open" : ""}`}>›</span>
        {summary}
      </button>
      {expanded && (
        <div className="tool-run-detail">
          {tools.map((tool) => {
            const toolFailed = tool.status === "failed";
            const result = toolFailed ? toolResultText(tool) : null;
            return (
              <div
                key={tool.id}
                className={`tool-row ${toolFailed ? "failed" : ""}`}
              >
                <div className="tool-row-header">
                  <span className="tool-row-glyph">
                    {toolGlyph(tool.status)}
                  </span>
                  <span className="tool-row-name">{toolDisplayName(tool)}</span>
                  {toolFailed && result !== null && (
                    <span className="tool-row-hint">
                      {t("tools.failureDetail")}
                    </span>
                  )}
                </div>
                {result !== null && (
                  <pre className={`tool-result ${toolFailed ? "failed" : ""}`}>
                    {result}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const text = plainText(message);
  return (
    <div className={`row ${message.role}`}>
      {message.content.map((content, i) => {
        if (content.type === "text") {
          // Assistant text renders as markdown (agents answer in it);
          // user text stays verbatim — echoing someone's asterisks back
          // as bold would misquote them. Replayed user text is display-
          // stripped of OUR wire preamble (transcriptDisplay).
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: message content arrays are wire-truth and only ever append — the index IS the stable identity
            <div key={i} className="bubble">
              {message.role === "assistant" ? (
                <MarkdownBody text={content.text} />
              ) : (
                stripWirePreamble(content.text)
              )}
              {message.isStreaming && <span className="cursor">▋</span>}
            </div>
          );
        }
        if (content.type === "tool") {
          // Tool inside a MIXED message (text + tool): a single quiet row.
          // Tool-ONLY messages never reach here — groupTranscript collapses
          // them into a ToolRunRow.
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: message content arrays are wire-truth and only ever append — the index IS the stable identity
            <div key={i} className="tool-row">
              {toolGlyph(content.tool.status)} {toolDisplayName(content.tool)}
            </div>
          );
        }
        if (content.type === "image") {
          return (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: message content arrays are wire-truth and only ever append — the index IS the stable identity
              key={i}
              className="attached-image"
              src={`data:${content.mimeType};base64,${content.data}`}
              alt=""
            />
          );
        }
        return null;
      })}
      {message.content.length === 0 && message.isStreaming && (
        <div className="bubble thinking-dots">…</div>
      )}
      {text === null &&
        message.content.length === 0 &&
        !message.isStreaming &&
        null}
    </div>
  );
}

export function ChatPopover({
  session,
  perch,
  variant = "full",
  anchor = "bottom",
}: {
  session: SessionView;
  perch: PerchView;
  /** "composer": no transcript yet — the popover is just the composer
   *  pill (plus the hint row when relevant). The parent sizes the window
   *  accordingly and upgrades to "full" when the first message lands. */
  variant?: "full" | "composer";
  /** Which edge of the overlay region faces the avatar — the composer-
   *  only pill hugs it. */
  anchor?: "top" | "bottom";
}) {
  const { t } = useTranslation("desktop-agent");
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Follow streaming output only while the user is already near the
  // bottom — otherwise every incoming chunk would yank the scroll back
  // to the latest token while someone reads earlier content.
  const followBottom = useRef(true);

  const noteScrollPosition = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followBottom.current = distanceFromBottom < 48;
  };

  // Pin to bottom only when we're following. useLayoutEffect avoids a
  // visible two-frame jump when a new chunk extends the transcript.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Focus the composer when the popover opens.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, []);

  const submit = () => {
    // Send gate: while a deferred create is in flight OR a run is
    // streaming on the live session, Enter must do nothing — goosed
    // allows one run per session (a concurrent prompt is rejected with
    // invalid_params), so mid-run sends are DISALLOWED here rather than
    // surfaced as wire errors. sendBusy() is the SYNCHRONOUS
    // view of the internal guards — checked before the draft clears, so
    // a bounced Enter never eats the message: the draft stays put and
    // the hint row already shows the streaming state.
    if (session.agentSendInFlight || session.sendBusy()) return;
    const text = draft;
    if (text.trim().length === 0) return;
    // House rule: the composer clears immediately after snapshotting.
    setDraft("");
    // Perch identity snapshots at SUBMIT — a send must not pick up a
    // perch that changed mid-flight (the capture/URL fetches below are
    // async and the user can dismount meanwhile).
    const source = chooseComposerSendSource({ perchPhase: perch.phase });
    const perchPhase = perch.phase;
    const perchApp = perch.appName;
    const perchTitle = perch.title;
    void (async () => {
      // Fresh per send: tabs change. Failures are null — never blocking.
      const artifactUrl =
        source === "perchedWindow" ? await perch.artifactUrlNow() : null;
      const makePreamble =
        source === "perchedWindow"
          ? (fullGuidance: boolean) =>
              perchSendPreamble({
                phase: perchPhase,
                appName: perchApp,
                title: perchTitle,
                artifactUrl,
                fullGuidance,
              })
          : null;
      // Fresh capture per send; failure degrades to a text-only send.
      const image =
        source === "perchedWindow" ? await perch.captureNow() : null;
      const dispatched = await session.send(
        text,
        image ? [{ type: "image", ...image }] : undefined,
        makePreamble,
      );
      // The gate check at the top of submit() ran BEFORE the async
      // capture/URL awaits above — a competing send that dispatched
      // during that gap closes the gate, and THIS send bounces off it
      // untouched (mutate-nothing contract). The snapshotted draft must
      // come back or the bounce eats the message. Only an untouched
      // composer is restored: overwriting text the user typed meanwhile
      // would trade one eaten message for another.
      if (!dispatched) {
        setDraft((current) => (current.length === 0 ? text : current));
      }
    })();
    inputRef.current?.focus();
  };

  // Display name for the armed selection: agents show their name; the
  // fresh entry shows the default identity.
  const pendingName =
    session.pendingSelection === null
      ? null
      : session.pendingSelection.kind === "agent"
        ? session.pendingSelection.agent.name
        : t("menu.fresh");

  const hint = deriveComposerHint({
    lastSendError: session.lastSendError,
    perchError: perch.lastError,
    perchPhase: perch.phase,
    perchApp: perch.appName,
    perchTitle: perch.title,
    attached: session.attached,
    connectionError: session.connectionError,
    reconnectExhausted: session.reconnectExhausted,
    sendStalled: session.sendStalled,
    agentSendInFlight: session.agentSendInFlight,
    pendingName,
    thinking: session.activity === "thinking",
  });

  const hintRow = hint && (
    <div className={`hint ${session.lastSendError ? "error" : ""}`}>
      {t(hint.key, hint.params)}
      {session.reconnectExhausted && !session.attached && (
        <button
          type="button"
          className="hint-retry"
          title={t("hint.retry")}
          onClick={() => session.retry()}
        >
          ↻
        </button>
      )}
    </div>
  );

  const composerBox = (
    <div className="composer-box">
      <input
        ref={inputRef}
        // focus-override: opts out of globals.css's global focus-visible
        // ring (the main-app composer convention — GlobalComposerPill
        // does the same). Without it, clicking into the input paints a
        // ring/offset box-shadow around it; the composer-box
        // :focus-within border is this composer's focus affordance.
        className="focus-override"
        value={draft}
        placeholder={
          variant === "composer"
            ? pendingName
              ? t("composer.startAgent", { name: pendingName })
              : t("composer.start")
            : pendingName
              ? t("composer.placeholderAgent", { name: pendingName })
              : t("composer.placeholder")
        }
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
        }}
      />
      <div className="composer-controls">
        {session.activity !== "none" ? (
          <button
            type="button"
            className="send-pill stop"
            title={t("composer.stop")}
            onClick={() => void session.stop()}
          >
            ◼
          </button>
        ) : (
          <button
            type="button"
            className="send-pill"
            title={t("composer.send")}
            onClick={submit}
            disabled={draft.trim().length === 0 || session.agentSendInFlight}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );

  // Composer-first: no transcript (and no empty hint) until a
  // conversation exists — just the pill, hugging the avatar edge. The
  // hint row (connection/perch problems) stays visible above it.
  if (variant === "composer") {
    return (
      <div className={`chat-popover composer-only anchor-${anchor}`}>
        {hintRow}
        {composerBox}
      </div>
    );
  }

  return (
    <div className="chat-popover">
      <div className="transcript" ref={scrollRef} onScroll={noteScrollPosition}>
        {session.messages.length === 0 && (
          <div className="empty-hint">
            {pendingName
              ? t("empty.newChat", { name: pendingName })
              : session.attached
                ? t("empty.prompt")
                : t("empty.waiting")}
          </div>
        )}
        {groupTranscript(session.messages).map((item) =>
          item.kind === "message" ? (
            <MessageRow key={item.message.id} message={item.message} />
          ) : (
            <ToolRunRow key={item.key} tools={item.tools} />
          ),
        )}
      </div>
      {hintRow}
      {composerBox}
    </div>
  );
}
