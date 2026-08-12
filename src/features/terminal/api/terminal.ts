import { Channel, invoke } from "@tauri-apps/api/core";

export type TerminalEvent =
  | {
      event: "started";
      data: {
        terminalId: string;
      };
    }
  | {
      event: "output";
      data: {
        terminalId: string;
        data: string;
      };
    }
  | {
      event: "exited";
      data: {
        terminalId: string;
        exitCode: number;
        signal: string | null;
      };
    }
  | {
      event: "error";
      data: {
        terminalId: string;
        message: string;
      };
    };

interface StartTerminalOptions {
  cwd: string;
  cols: number;
  rows: number;
  onEvent: (event: TerminalEvent) => void;
}

export async function startTerminal({
  cwd,
  cols,
  rows,
  onEvent,
}: StartTerminalOptions): Promise<string> {
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("start_terminal", {
    cwd,
    cols,
    rows,
    onEvent: channel,
  });
}

export async function writeTerminal(
  terminalId: string,
  data: string,
): Promise<void> {
  return invoke("write_terminal", { terminalId, data });
}

export async function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { terminalId, cols, rows });
}

export async function stopTerminal(terminalId: string): Promise<void> {
  return invoke("stop_terminal", { terminalId });
}
