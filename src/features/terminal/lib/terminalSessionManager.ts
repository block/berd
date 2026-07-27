import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IDisposable, ITheme } from "@xterm/xterm";
import {
  resizeTerminal,
  startTerminal,
  stopTerminal,
  writeTerminal,
  type TerminalEvent,
} from "../api/terminal";

export type TerminalStatus = "starting" | "running" | "exited" | "error";

export interface TerminalSessionLabels {
  startFailed: string;
  stopped: string;
  exitedWithSignal: (signal: string) => string;
}

interface TerminalSessionOptions {
  key: string;
  cwd: string;
  labels: TerminalSessionLabels;
  theme: ITheme;
  fontFamily: string;
}

interface TerminalSessionStopOptions {
  writeStopped?: boolean;
}

type TerminalSessionListener = () => void;
export type TerminalSessionRegistryListener = () => void;
export type TerminalSessionStatusSource =
  | "backend-exit"
  | "client-stop"
  | "start"
  | "error";

export interface TerminalSessionStatusChange {
  key: string;
  status: TerminalStatus;
  previousStatus: TerminalStatus;
  source: TerminalSessionStatusSource;
}

type TerminalSessionStatusListener = (
  change: TerminalSessionStatusChange,
) => void;

const MIN_COLS = 20;
const MIN_ROWS = 5;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERMINAL_SCROLLBAR_TRACK_WIDTH_PX = 8;
const MAX_BUFFERED_OUTPUT_CHARS = 1_000_000;
const MAX_OUTPUT_WRITE_CHARS_PER_FRAME = 64 * 1024;
const TERMINAL_PARKING_ROOT_ID = "goose-terminal-parking-root";

const sessions = new Map<string, TerminalSession>();
const queuedCommands = new Map<string, string[]>();
const statusListeners = new Map<string, Set<TerminalSessionStatusListener>>();
const registryListeners = new Set<TerminalSessionRegistryListener>();
let terminalSessionIdsSnapshot = new Set<string>();
let renderingSuspended = false;

function createTerminalHostElement(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.height = "100%";
  element.style.minHeight = "0";
  element.style.overflow = "hidden";
  element.style.width = "100%";
  return element;
}

function getTerminalParkingRoot(): HTMLDivElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const existing = document.getElementById(TERMINAL_PARKING_ROOT_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const element = document.createElement("div");
  element.id = TERMINAL_PARKING_ROOT_ID;
  element.setAttribute("aria-hidden", "true");
  element.style.display = "none";
  document.body.appendChild(element);
  return element;
}

function parkTerminalHostElement(element: HTMLDivElement): void {
  // xterm owns the terminal DOM after open(); `terminal.element` is its
  // containing element, and open() must run against a visible/measured parent:
  // https://xtermjs.org/docs/api/terminal/classes/terminal/#element
  // https://xtermjs.org/docs/api/terminal/classes/terminal/#open
  //
  // Park the stable host outside React's unmounting subtree so switching
  // sessions does not make React synchronously tear down xterm's scrollback and
  // renderer surface. The next attach moves this same host back into view.
  getTerminalParkingRoot()?.appendChild(element);
}

function clearQueuedCommands(sessionKey: string): void {
  queuedCommands.delete(sessionKey);
}

function openTerminalLink(event: MouseEvent, uri: string): void {
  event.preventDefault();
  void openUrl(uri).catch((error) => {
    console.warn("Failed to open terminal link", error);
  });
}

function formatCommandInput(command: string): string {
  const trimmedCommand = command.trimEnd();
  if (!trimmedCommand) {
    return "";
  }

  return `${trimmedCommand}\r`;
}

function readChatSessionIdsWithTerminals(): Set<string> {
  const sessionIds = new Set<string>();
  for (const [key, session] of sessions) {
    if (session.status === "exited") {
      continue;
    }

    const sessionId = chatSessionIdFromTerminalKey(key);
    if (sessionId) {
      sessionIds.add(sessionId);
    }
  }

  return sessionIds;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }

  return true;
}

function emitRegistryChange(): void {
  const nextSnapshot = readChatSessionIdsWithTerminals();
  if (setsEqual(terminalSessionIdsSnapshot, nextSnapshot)) {
    return;
  }

  terminalSessionIdsSnapshot = nextSnapshot;
  for (const listener of registryListeners) {
    listener();
  }
}

function emitStatusChange(change: TerminalSessionStatusChange): void {
  const listeners = statusListeners.get(change.key);
  if (listeners) {
    for (const listener of listeners) {
      listener(change);
    }
  }

  emitRegistryChange();
}

export class TerminalSession {
  readonly key: string;
  readonly cwd: string;
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;

  private terminalId: string | null = null;
  private labels: TerminalSessionLabels;
  private statusValue: TerminalStatus = "starting";
  private startupToken: symbol | null = null;
  private inputSubscription: IDisposable | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastBackendCols: number | null = null;
  private lastBackendRows: number | null = null;
  private pendingBackendCols: number | null = null;
  private pendingBackendRows: number | null = null;
  private fontReadyToken = 0;
  private animationFrame = 0;
  private queuedOutput = "";
  private outputAnimationFrame = 0;
  private outputWriteInFlight = false;
  private outputWriteToken = 0;
  private fitDeferred = false;
  private hostElement: HTMLDivElement | null = null;
  private attachedContainer: HTMLDivElement | null = null;
  private disposed = false;
  private listeners = new Set<TerminalSessionListener>();

  constructor({ key, cwd, labels, theme, fontFamily }: TerminalSessionOptions) {
    this.key = key;
    this.cwd = cwd;
    this.labels = labels;
    this.fitAddon = new FitAddon();
    this.terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      overviewRuler: { width: TERMINAL_SCROLLBAR_TRACK_WIDTH_PX },
      scrollback: 10_000,
      theme,
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon(openTerminalLink));
    this.inputSubscription = this.terminal.onData((data) => {
      if (!this.terminalId) {
        return;
      }

      void writeTerminal(this.terminalId, data).catch((error) => {
        console.warn("Failed to write terminal input", error);
      });
    });
    this.start();
  }

  get status(): TerminalStatus {
    return this.statusValue;
  }

  updateLabels(labels: TerminalSessionLabels): void {
    this.labels = labels;
  }

  updateAppearance(theme: ITheme, fontFamily: string): void {
    this.terminal.options.theme = theme;
    this.terminal.options.fontFamily = fontFamily;
    this.refreshAfterFontsReady();
  }

  subscribe(listener: TerminalSessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  attach(container: HTMLDivElement): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    this.attachedContainer = container;
    container.textContent = "";
    const hostElement = this.hostElement ?? createTerminalHostElement();
    this.hostElement = hostElement;
    container.appendChild(hostElement);
    if (!this.terminal.element) {
      // First open only: xterm measures its parent during open(), so this must
      // happen after the host is in the visible panel, not while parked.
      this.terminal.open(hostElement);
    }
    this.refreshAfterFontsReady();
    this.scheduleFitAndResize();
    this.scheduleOutputDrain();

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleFitAndResize();
    });
    this.resizeObserver.observe(container);

    return () => {
      this.detach(container);
    };
  }

  detach(container: HTMLDivElement): void {
    if (this.disposed || this.attachedContainer !== container) {
      return;
    }

    this.attachedContainer = null;
    if (this.hostElement) {
      parkTerminalHostElement(this.hostElement);
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.cancelOutputDrain();
  }

  focusAndResize(): void {
    if (this.disposed || renderingSuspended) {
      return;
    }

    this.fitDeferred = false;
    this.scheduleFitAndResize();
    this.terminal.focus();
  }

  deferResize(): void {
    if (this.disposed) {
      return;
    }

    this.fitDeferred = true;
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  resumeResize({ focus = false }: { focus?: boolean } = {}): void {
    if (this.disposed) {
      return;
    }

    this.fitDeferred = false;
    this.scheduleFitAndResize();
    if (focus && !renderingSuspended) {
      this.terminal.focus();
    }
  }

  suspendRendering(): void {
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.cancelOutputDrain();
  }

  resumeRendering(): void {
    if (this.disposed || renderingSuspended || !this.attachedContainer) {
      return;
    }

    this.scheduleFitAndResize();
    this.scheduleOutputDrain();
  }

  runCommand(command: string): void {
    if (this.disposed) {
      return;
    }

    const input = formatCommandInput(command);
    if (!input) {
      return;
    }

    if (!this.terminalId || this.statusValue !== "running") {
      const existing = queuedCommands.get(this.key) ?? [];
      existing.push(input);
      queuedCommands.set(this.key, existing);
      if (this.statusValue === "exited" || this.statusValue === "error") {
        this.restart();
      }
      return;
    }

    void writeTerminal(this.terminalId, input).catch((error) => {
      console.warn("Failed to run terminal command", error);
    });
  }

  restart(): void {
    if (this.disposed) {
      return;
    }

    const terminalId = this.terminalId;
    this.terminalId = null;
    if (terminalId) {
      void stopTerminal(terminalId);
    }
    this.clearQueuedOutput();
    this.terminal.clear();
    this.start();
  }

  stop({ writeStopped = false }: TerminalSessionStopOptions = {}): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    sessions.delete(this.key);
    emitRegistryChange();
    clearQueuedCommands(this.key);
    this.startupToken = null;
    this.hostElement?.remove();
    this.attachedContainer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.cancelOutputDrain();
    this.clearQueuedOutput();
    if (writeStopped) {
      this.terminal.writeln("");
      this.terminal.writeln(`[${this.labels.stopped}]`);
    }

    const terminalId = this.terminalId;
    this.terminalId = null;
    if (terminalId) {
      void stopTerminal(terminalId);
    }
    this.inputSubscription?.dispose();
    this.inputSubscription = null;
    this.terminal.dispose();
    this.setStatus("exited", "client-stop");
    this.listeners.clear();
  }

  private start(): void {
    const startupToken = Symbol("terminal-startup");
    this.startupToken = startupToken;
    this.setStatus("starting", "start");

    const cols = Math.max(this.terminal.cols || DEFAULT_COLS, MIN_COLS);
    const rows = Math.max(this.terminal.rows || DEFAULT_ROWS, MIN_ROWS);
    this.lastBackendCols = cols;
    this.lastBackendRows = rows;
    this.pendingBackendCols = null;
    this.pendingBackendRows = null;

    void startTerminal({
      cwd: this.cwd,
      cols,
      rows,
      onEvent: (event) => {
        if (this.disposed || this.startupToken !== startupToken) {
          return;
        }

        this.handleTerminalEvent(event);
      },
    })
      .then((terminalId) => {
        if (this.disposed || this.startupToken !== startupToken) {
          void stopTerminal(terminalId);
          return;
        }

        this.terminalId = terminalId;
        this.setStatus("running", "start");
        this.scheduleFitAndResize();
      })
      .catch((error) => {
        if (this.disposed || this.startupToken !== startupToken) {
          return;
        }

        this.setStatus("error", "error");
        const message =
          error instanceof Error ? error.message : this.labels.startFailed;
        this.terminal.writeln(`[${message}]`);
      });
  }

  private handleTerminalEvent(event: TerminalEvent): void {
    switch (event.event) {
      case "started":
        this.terminalId = event.data.terminalId;
        this.setStatus("running", "start");
        this.scheduleFitAndResize();
        break;
      case "output":
        this.enqueueOutput(event.data.data);
        break;
      case "exited":
        this.terminalId = null;
        this.lastBackendCols = null;
        this.lastBackendRows = null;
        this.pendingBackendCols = null;
        this.pendingBackendRows = null;
        if (event.data.signal) {
          this.terminal.writeln("");
          this.terminal.writeln(
            `[${this.labels.exitedWithSignal(event.data.signal)}]`,
          );
        }
        this.setStatus("exited", "backend-exit");
        break;
      case "error":
        this.setStatus("error", "error");
        this.terminal.writeln("");
        this.terminal.writeln(`[${event.data.message}]`);
        break;
    }
  }

  private scheduleFitAndResize(): void {
    if (this.fitDeferred || renderingSuspended) {
      return;
    }

    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = window.requestAnimationFrame(() => {
      this.animationFrame = 0;
      this.fitAndResize();
    });
  }

  private enqueueOutput(data: string): void {
    if (this.disposed || !data) {
      return;
    }

    this.queuedOutput += data;
    if (this.queuedOutput.length > MAX_BUFFERED_OUTPUT_CHARS) {
      this.queuedOutput = this.queuedOutput.slice(-MAX_BUFFERED_OUTPUT_CHARS);
    }
    this.scheduleOutputDrain();
  }

  private scheduleOutputDrain(): void {
    // Backend output can arrive while the user is clicking between sessions.
    // Keep xterm parsing/rendering out of the event callback, cap each frame's
    // work, and do not render parked terminals until they are visible again.
    if (
      this.disposed ||
      renderingSuspended ||
      this.outputAnimationFrame ||
      this.outputWriteInFlight ||
      !this.attachedContainer ||
      !this.queuedOutput
    ) {
      return;
    }

    this.outputAnimationFrame = window.requestAnimationFrame(() => {
      this.outputAnimationFrame = 0;
      this.writeNextOutputChunk();
    });
  }

  private writeNextOutputChunk(): void {
    if (
      this.disposed ||
      renderingSuspended ||
      this.outputWriteInFlight ||
      !this.attachedContainer ||
      !this.queuedOutput
    ) {
      return;
    }

    const output = this.queuedOutput.slice(0, MAX_OUTPUT_WRITE_CHARS_PER_FRAME);
    this.queuedOutput = this.queuedOutput.slice(output.length);
    this.outputWriteInFlight = true;
    const token = this.outputWriteToken;
    this.terminal.write(output, () => {
      if (this.disposed || token !== this.outputWriteToken) {
        return;
      }

      this.outputWriteInFlight = false;
      this.scheduleOutputDrain();
    });
  }

  private clearQueuedOutput(): void {
    this.queuedOutput = "";
    this.outputWriteInFlight = false;
    this.cancelOutputDrain();
    this.outputWriteToken += 1;
  }

  private cancelOutputDrain(): void {
    if (this.outputAnimationFrame) {
      window.cancelAnimationFrame(this.outputAnimationFrame);
      this.outputAnimationFrame = 0;
    }
  }

  private fitAndResize(): void {
    const container = this.attachedContainer;
    if (
      this.disposed ||
      renderingSuspended ||
      !container ||
      container.clientWidth <= 0 ||
      container.clientHeight <= 0
    ) {
      return;
    }

    try {
      this.fitAddon.fit();
    } catch (error) {
      console.warn("Failed to fit terminal", error);
      return;
    }

    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const matchesBackend =
      cols === this.lastBackendCols && rows === this.lastBackendRows;
    const matchesPending =
      cols === this.pendingBackendCols && rows === this.pendingBackendRows;

    if (this.terminalId && !matchesBackend && !matchesPending) {
      const terminalId = this.terminalId;
      this.pendingBackendCols = cols;
      this.pendingBackendRows = rows;

      void resizeTerminal(terminalId, cols, rows)
        .then(() => {
          if (
            this.disposed ||
            this.terminalId !== terminalId ||
            this.pendingBackendCols !== cols ||
            this.pendingBackendRows !== rows
          ) {
            return;
          }

          this.lastBackendCols = cols;
          this.lastBackendRows = rows;
          this.pendingBackendCols = null;
          this.pendingBackendRows = null;
          if (this.terminal.cols !== cols || this.terminal.rows !== rows) {
            this.scheduleFitAndResize();
          }
        })
        .catch((error) => {
          if (
            this.terminalId === terminalId &&
            this.pendingBackendCols === cols &&
            this.pendingBackendRows === rows
          ) {
            this.pendingBackendCols = null;
            this.pendingBackendRows = null;
          }

          console.warn("Failed to resize terminal", error);
        });
    }
  }

  private refreshAfterFontsReady(): void {
    if (typeof document === "undefined" || !document.fonts) {
      return;
    }

    this.fontReadyToken += 1;
    const fontReadyToken = this.fontReadyToken;
    void document.fonts.ready.then(() => {
      if (this.disposed || this.fontReadyToken !== fontReadyToken) {
        return;
      }

      if (renderingSuspended) {
        return;
      }

      this.terminal.refresh(0, Math.max(this.terminal.rows - 1, 0));
    });
  }

  private flushQueuedCommands(): void {
    if (!this.terminalId || this.statusValue !== "running") {
      return;
    }

    const commands = queuedCommands.get(this.key);
    if (!commands?.length) {
      return;
    }

    queuedCommands.delete(this.key);
    const terminalId = this.terminalId;
    for (const command of commands) {
      void writeTerminal(terminalId, command).catch((error) => {
        console.warn("Failed to run queued terminal command", error);
      });
    }
  }

  private setStatus(
    status: TerminalStatus,
    source: TerminalSessionStatusSource,
  ): void {
    const previousStatus = this.statusValue;
    this.statusValue = status;
    if (status === "running") {
      this.flushQueuedCommands();
    }
    emitStatusChange({
      key: this.key,
      status,
      previousStatus,
      source,
    });
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function queueTerminalCommand(
  sessionKey: string,
  command: string,
): void {
  const input = formatCommandInput(command);
  if (!input) {
    return;
  }

  const existing = queuedCommands.get(sessionKey) ?? [];
  existing.push(input);
  queuedCommands.set(sessionKey, existing);
}

export function runCommandInTerminalSession(
  sessionKey: string,
  command: string,
): boolean {
  const session = sessions.get(sessionKey);
  if (!session) {
    return false;
  }

  session.runCommand(command);
  return true;
}

export function restartTerminalSession(sessionKey: string): boolean {
  const session = sessions.get(sessionKey);
  if (!session) {
    return false;
  }

  session.restart();
  return true;
}

export function stopTerminalSession(
  sessionKey: string,
  options: TerminalSessionStopOptions = {},
): boolean {
  const session = sessions.get(sessionKey);
  if (!session) {
    clearQueuedCommands(sessionKey);
    return false;
  }

  session.stop(options);
  return true;
}

export function subscribeTerminalSessionStatus(
  sessionKey: string,
  listener: TerminalSessionStatusListener,
): () => void {
  const listeners = statusListeners.get(sessionKey) ?? new Set();
  listeners.add(listener);
  statusListeners.set(sessionKey, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      statusListeners.delete(sessionKey);
    }
  };
}

export function getTerminalSessionStatus(
  sessionKey: string,
): TerminalStatus | null {
  return sessions.get(sessionKey)?.status ?? null;
}

export function setTerminalRenderingSuspended(suspended: boolean): void {
  if (renderingSuspended === suspended) {
    return;
  }

  renderingSuspended = suspended;

  for (const session of sessions.values()) {
    if (suspended) {
      session.suspendRendering();
    } else {
      session.resumeRendering();
    }
  }
}

export function getOrCreateTerminalSession(
  options: TerminalSessionOptions,
): TerminalSession {
  const existing = sessions.get(options.key);
  if (existing && existing.cwd === options.cwd) {
    existing.updateLabels(options.labels);
    existing.updateAppearance(options.theme, options.fontFamily);
    return existing;
  }

  existing?.stop();
  const session = new TerminalSession(options);
  sessions.set(options.key, session);
  emitRegistryChange();
  return session;
}

function chatSessionIdFromTerminalKey(key: string): string | null {
  // Chat terminals are keyed as `{chatSessionId}:{terminalTabId}` by ChatView.
  // The registry exposes the chat-session owner so draft-like terminal state can
  // keep otherwise-empty chats reachable in the sidebar.
  const separatorIndex = key.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return key.slice(0, separatorIndex);
}

export function getChatSessionIdsWithTerminals(): ReadonlySet<string> {
  return terminalSessionIdsSnapshot;
}

export function subscribeTerminalSessionRegistry(
  listener: TerminalSessionRegistryListener,
): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}
