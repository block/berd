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
  private animationFrame = 0;
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
    this.terminal.loadAddon(new WebLinksAddon());
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

    this.scheduleFitAndResize();
    this.terminal.focus();
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

    if (this.terminalId) {
      void resizeTerminal(
        this.terminalId,
        this.terminal.cols,
        this.terminal.rows,
      ).catch((error) => {
        console.warn("Failed to resize terminal", error);
      });
    }
  }

  private setStatus(status: TerminalStatus): void {
    this.statusValue = status;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function getOrCreateTerminalSession(
  options: TerminalSessionOptions,
): TerminalSession {
  const existing = sessions.get(options.key);
  if (existing && existing.cwd === options.cwd) {
    existing.updateLabels(options.labels);
    return existing;
  }

  existing?.stop();
  const session = new TerminalSession(options);
  sessions.set(options.key, session);
  return session;
}
