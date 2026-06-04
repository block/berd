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

type TerminalSessionListener = () => void;

const MIN_COLS = 20;
const MIN_ROWS = 5;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const sessions = new Map<string, TerminalSession>();
const queuedCommands = new Map<string, string[]>();

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
  private fitDeferred = false;
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
    if (this.terminal.element) {
      container.appendChild(this.terminal.element);
    } else {
      this.terminal.open(container);
    }
    this.terminal.focus();
    this.refreshAfterFontsReady();
    this.scheduleFitAndResize();

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleFitAndResize();
    });
    this.resizeObserver.observe(container);

    return () => {
      if (this.attachedContainer === container) {
        this.attachedContainer = null;
      }
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.animationFrame) {
        window.cancelAnimationFrame(this.animationFrame);
        this.animationFrame = 0;
      }
    };
  }

  focusAndResize(): void {
    if (this.disposed) {
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
    if (focus) {
      this.terminal.focus();
    }
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
    this.terminal.clear();
    this.start();
  }

  stop({ writeStopped = false }: { writeStopped?: boolean } = {}): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    sessions.delete(this.key);
    clearQueuedCommands(this.key);
    this.startupToken = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
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
    this.setStatus("exited");
    this.listeners.clear();
  }

  private start(): void {
    const startupToken = Symbol("terminal-startup");
    this.startupToken = startupToken;
    this.setStatus("starting");

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
        this.setStatus("running");
        this.fitAndResize();
      })
      .catch((error) => {
        if (this.disposed || this.startupToken !== startupToken) {
          return;
        }

        this.setStatus("error");
        const message =
          error instanceof Error ? error.message : this.labels.startFailed;
        this.terminal.writeln(`[${message}]`);
      });
  }

  private handleTerminalEvent(event: TerminalEvent): void {
    switch (event.event) {
      case "started":
        this.terminalId = event.data.terminalId;
        this.setStatus("running");
        this.fitAndResize();
        break;
      case "output":
        this.terminal.write(event.data.data);
        break;
      case "exited":
        this.terminalId = null;
        this.lastBackendCols = null;
        this.lastBackendRows = null;
        this.pendingBackendCols = null;
        this.pendingBackendRows = null;
        this.setStatus("exited");
        if (event.data.signal) {
          this.terminal.writeln("");
          this.terminal.writeln(
            `[${this.labels.exitedWithSignal(event.data.signal)}]`,
          );
        }
        break;
      case "error":
        this.setStatus("error");
        this.terminal.writeln("");
        this.terminal.writeln(`[${event.data.message}]`);
        break;
    }
  }

  private scheduleFitAndResize(): void {
    if (this.fitDeferred) {
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

  private fitAndResize(): void {
    const container = this.attachedContainer;
    if (
      this.disposed ||
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

  private setStatus(status: TerminalStatus): void {
    this.statusValue = status;
    if (status === "running") {
      this.flushQueuedCommands();
    }
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
  return session;
}
