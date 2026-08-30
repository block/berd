import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ENV_PORT = process.env.APP_TEST_DRIVER_PORT;
const TOKEN = process.env.APP_TEST_DRIVER_TOKEN;
const RUN_ROOT = process.env.BERD_E2E_RUN_ROOT;
const READY_FILE_NAME = "app-test-driver.json";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 100;

interface TestDriverCommand {
  token: string;
  action: string;
  selector?: string;
  value?: string;
  timeout?: number;
}

interface TestDriverResult {
  success: boolean;
  data?: string;
  error?: string;
}

interface DriverReady {
  host: string;
  port: number;
  pid: number;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "APP_TEST_DRIVER_PORT must be an integer between 1 and 65535",
    );
  }
  return port;
}

function validateReady(value: unknown): DriverReady {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as DriverReady).host !== "127.0.0.1" ||
    !Number.isInteger((value as DriverReady).port) ||
    (value as DriverReady).port < 1 ||
    (value as DriverReady).port > 65_535 ||
    !Number.isInteger((value as DriverReady).pid) ||
    (value as DriverReady).pid < 1
  ) {
    throw new Error("Invalid app test driver readiness file");
  }
  return value as DriverReady;
}

async function resolveDriverPort({
  port,
  runRoot,
}: {
  port?: number;
  runRoot?: string;
}): Promise<number> {
  if (port !== undefined) return port;
  if (!runRoot) {
    throw new Error(
      "BERD_E2E_RUN_ROOT is required to discover the app test driver port",
    );
  }

  const readyFile = path.join(runRoot, READY_FILE_NAME);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const ready = validateReady(
        JSON.parse(await readFile(readyFile, "utf8")),
      );
      try {
        process.kill(ready.pid, 0);
      } catch {
        throw new Error(
          `App test driver readiness references inactive PID ${ready.pid}`,
        );
      }
      return ready.port;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, READY_POLL_INTERVAL_MS),
      );
    }
  }
  throw new Error(
    `Timed out waiting for app test driver readiness at ${readyFile}: ${String(lastError)}`,
  );
}

export interface TestDriver {
  snapshot: () => Promise<string>;
  click: (selector?: string, options?: { timeout?: number }) => Promise<string>;
  fill: (
    selector: string,
    value: string,
    options?: { timeout?: number },
  ) => Promise<string>;
  getText: (
    selector?: string,
    options?: { timeout?: number },
  ) => Promise<string>;
  count: (selector: string) => Promise<number>;
  keypress: (
    selector?: string,
    key?: string,
    options?: { timeout?: number },
  ) => Promise<string>;
  waitForText: (
    text: string,
    options?: { selector?: string; timeout?: number },
  ) => Promise<string>;
  scroll: (direction?: string) => Promise<string>;
  screenshot: (path?: string) => Promise<string>;
  /** Wait until the driver accepts a fresh connection. Never replays a command. */
  reconnect: () => Promise<void>;
  close: () => void;
}

export function isTestDriverConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Test driver socket") ||
    message.includes("socket closed before response") ||
    message.includes("Cannot connect to test driver") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE")
  );
}

export async function reconnectTestDriverUntilElement(
  driver: TestDriver,
  selector: string,
  {
    timeout = READY_TIMEOUT_MS,
    stableMs = 500,
  }: { timeout?: number; stableMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await driver.reconnect();
      if ((await driver.count(selector)) > 0) {
        await new Promise((resolve) => setTimeout(resolve, stableMs));
        if ((await driver.count(selector)) > 0) return;
      }
    } catch (error) {
      if (!isTestDriverConnectionError(error)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for the test driver to reconnect with ${selector}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

function send(socket: net.Socket, command: TestDriverCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        cleanup();
        try {
          const parsed: TestDriverResult = JSON.parse(data.trim());
          if (parsed.success) {
            resolve(parsed.data ?? "");
          } else {
            reject(new Error(parsed.error || "Unknown test driver error"));
          }
        } catch (_e) {
          reject(new Error(`Invalid response: ${data}`));
        }
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Test driver socket error: ${err.message}`));
    };

    const onClose = () => {
      cleanup();
      reject(
        new Error("Test driver socket closed before response was received"),
      );
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

/**
 * Create a client connection to the Tauri app test driver.
 * Returns an object with methods for each test driver command.
 */
export async function createTestDriver({
  port = parsePort(ENV_PORT),
  token = TOKEN,
  runRoot = RUN_ROOT,
}: {
  port?: number;
  token?: string;
  runRoot?: string;
} = {}): Promise<TestDriver> {
  if (!token) {
    throw new Error(
      "APP_TEST_DRIVER_TOKEN is required to connect to the test driver",
    );
  }
  const resolvedPort = await resolveDriverPort({ port, runRoot });
  const connect = () =>
    new Promise<net.Socket>((resolve, reject) => {
      const nextSocket = net.createConnection({
        port: resolvedPort,
        host: "127.0.0.1",
      });
      const onConnect = () => {
        nextSocket.removeListener("error", onError);
        resolve(nextSocket);
      };
      const onError = (err: Error) => {
        nextSocket.removeListener("connect", onConnect);
        nextSocket.destroy();
        reject(
          new Error(
            `Cannot connect to test driver on port ${resolvedPort}. ` +
              `Is the Tauri app running with --features app-test-driver? (${err.message})`,
          ),
        );
      };
      nextSocket.once("connect", onConnect);
      nextSocket.once("error", onError);
    });
  const waitForConnection = async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const socket = await connect();
        socket.destroy();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) =>
          setTimeout(resolve, READY_POLL_INTERVAL_MS),
        );
      }
    }
    throw new Error(
      `Timed out reconnecting to test driver on port ${resolvedPort}: ${String(lastError)}`,
    );
  };
  await waitForConnection();
  let closed = false;

  const authenticatedSend = async (
    command: Omit<TestDriverCommand, "token">,
  ): Promise<string> => {
    if (closed) throw new Error("Test driver client is closed");
    const socket = await connect();
    try {
      return await send(socket, { ...command, token });
    } finally {
      socket.destroy();
    }
  };

  return {
    snapshot() {
      return authenticatedSend({ action: "snapshot" });
    },
    click(selector?: string, options?: { timeout?: number }) {
      return authenticatedSend({
        action: "click",
        selector,
        timeout: options?.timeout,
      });
    },
    fill(selector: string, value: string, options?: { timeout?: number }) {
      return authenticatedSend({
        action: "fill",
        selector,
        value,
        timeout: options?.timeout,
      });
    },
    getText(selector?: string, options?: { timeout?: number }) {
      return authenticatedSend({
        action: "getText",
        selector,
        timeout: options?.timeout,
      });
    },
    count(selector: string) {
      return authenticatedSend({ action: "count", selector }).then(Number);
    },
    keypress(selector?: string, key?: string, options?: { timeout?: number }) {
      return authenticatedSend({
        action: "keypress",
        selector,
        value: key,
        timeout: options?.timeout,
      });
    },
    waitForText(
      text: string,
      options?: { selector?: string; timeout?: number },
    ) {
      return authenticatedSend({
        action: "waitForText",
        selector: options?.selector ?? "body",
        value: text,
        timeout: options?.timeout ?? 30000,
      });
    },
    scroll(direction?: string) {
      return authenticatedSend({ action: "scroll", value: direction });
    },
    screenshot(path?: string) {
      return authenticatedSend({ action: "screenshot", value: path });
    },
    async reconnect() {
      if (closed) throw new Error("Test driver client is closed");
      await waitForConnection();
    },
    close() {
      closed = true;
    },
  };
}
