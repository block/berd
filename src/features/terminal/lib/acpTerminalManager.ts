import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

import { clearAgentTerminalTabStates } from "./acpTerminalTabState";

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const PENDING_EXTERNAL_OUTPUT_BYTE_LIMIT = DEFAULT_OUTPUT_BYTE_LIMIT;
const PENDING_EXTERNAL_EVENT_TTL_MS = 60_000;
const CONNECTION_CLOSED_STATUS: WaitForTerminalExitResponse = {
  exitCode: null,
  signal: "SIGTERM",
};

interface AcpTerminalRecord {
  sessionId: string;
  terminalId: string;
  cwd: string;
  title: string;
  output: string;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus: WaitForTerminalExitResponse | null;
  released: boolean;
  terminal: { kill(): Promise<void> } | null;
  waiters: Set<(status: WaitForTerminalExitResponse) => void>;
}

interface ExternalTerminalInfo {
  sessionId: string;
  terminalId: string;
  cwd: string;
  title: string;
}

interface PendingExternalTerminalEvents {
  output: string;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

export interface AcpTerminalOpenRequest {
  sessionId: string;
  terminalId: string;
  cwd: string;
  title: string;
  focus: boolean;
}

type AcpTerminalOpenListener = (request: AcpTerminalOpenRequest) => void;
type AcpTerminalCapabilityListener = () => void;

const records = new Map<string, AcpTerminalRecord>();
const externalTerminalInfo = new Map<string, ExternalTerminalInfo>();
const externalTerminalReady = new Map<string, Promise<void>>();
const pendingExternalTerminalEvents = new Map<
  string,
  PendingExternalTerminalEvents
>();
const autoOpenDismissed = new Set<string>();
const openListeners = new Set<AcpTerminalOpenListener>();
const capabilityListeners = new Map<
  string,
  Set<AcpTerminalCapabilityListener>
>();
let lifecycleGeneration = 0;

function sessionKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}

function emitCapabilityChange(key: string): void {
  for (const listener of capabilityListeners.get(key) ?? []) listener();
}

function enforceOutputLimit(record: AcpTerminalRecord): void {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(record.output);
  if (encoded.byteLength <= record.outputByteLimit) return;

  let start = encoded.byteLength - record.outputByteLimit;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  record.output = new TextDecoder().decode(encoded.slice(start));
  record.truncated = true;
}

function finishRecord(
  record: AcpTerminalRecord,
  status: WaitForTerminalExitResponse,
): void {
  if (record.exitStatus) return;
  record.exitStatus = status;
  emitCapabilityChange(sessionKey(record.sessionId, record.terminalId));
  for (const resolve of record.waiters) resolve(status);
  record.waiters.clear();
}

function getRecord(sessionId: string, terminalId: string): AcpTerminalRecord {
  const record = records.get(sessionKey(sessionId, terminalId));
  if (!record || record.released) {
    throw new Error("Terminal session was not found.");
  }
  return record;
}

function envRecord(env: CreateTerminalRequest["env"]): Record<string, string> {
  return Object.fromEntries(
    (env ?? []).map(({ name, value }) => [name, value]),
  );
}

function trimToByteLimit(value: string, byteLimit: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= byteLimit) return value;
  let start = encoded.byteLength - byteLimit;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder().decode(encoded.slice(start));
}

function deletePendingExternalEvents(key: string): void {
  const pending = pendingExternalTerminalEvents.get(key);
  if (pending) clearTimeout(pending.cleanupTimer);
  pendingExternalTerminalEvents.delete(key);
}

function pendingExternalEvents(key: string): PendingExternalTerminalEvents {
  const existing = pendingExternalTerminalEvents.get(key);
  if (existing) return existing;
  const pending: PendingExternalTerminalEvents = {
    output: "",
    exitStatus: null,
    cleanupTimer: setTimeout(
      () => pendingExternalTerminalEvents.delete(key),
      PENDING_EXTERNAL_EVENT_TTL_MS,
    ),
  };
  pendingExternalTerminalEvents.set(key, pending);
  return pending;
}

export async function createAcpTerminal(
  request: CreateTerminalRequest,
): Promise<CreateTerminalResponse> {
  const generation = lifecycleGeneration;
  const terminalId = `agent-${crypto.randomUUID()}`;
  const key = sessionKey(request.sessionId, terminalId);
  const title =
    request.command === "sh" && request.args?.[0] === "-c" && request.args[1]
      ? request.args[1].split("\n", 1)[0]
      : [request.command, ...(request.args ?? [])].join(" ");
  const record: AcpTerminalRecord = {
    sessionId: request.sessionId,
    terminalId,
    cwd: request.cwd ?? "~",
    title,
    output: "",
    outputByteLimit: Math.max(
      0,
      request.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
    ),
    truncated: false,
    exitStatus: null,
    released: false,
    terminal: null,
    waiters: new Set(),
  };
  records.set(key, record);

  let terminal: { kill(): Promise<void> };
  try {
    const { getOrCreateTerminalSession } = await import(
      "@/features/terminal/lib/terminalSessionManager"
    );
    if (generation !== lifecycleGeneration) {
      throw new Error("ACP connection closed while creating terminal.");
    }
    terminal = getOrCreateTerminalSession({
      key,
      cwd: request.cwd ?? "~",
      labels: {
        startFailed: "Could not start agent terminal.",
        stopped: "Terminal stopped",
        exitedWithSignal: (signal) => `Exited by ${signal}`,
      },
      theme: {},
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      launch: {
        command: request.command,
        args: request.args,
        env: envRecord(request.env),
      },
      onOutput: (data) => {
        record.output += data;
        enforceOutputLimit(record);
      },
      onExit: (status) => finishRecord(record, status),
    });
  } catch (error) {
    records.delete(key);
    throw error;
  }

  record.terminal = terminal;
  emitCapabilityChange(key);
  return { terminalId };
}

export async function readAcpTerminalOutput(
  request: TerminalOutputRequest,
): Promise<TerminalOutputResponse> {
  const record = getRecord(request.sessionId, request.terminalId);
  return {
    output: record.output,
    truncated: record.truncated,
    exitStatus: record.exitStatus,
  };
}

export async function waitForAcpTerminalExit(
  request: WaitForTerminalExitRequest,
): Promise<WaitForTerminalExitResponse> {
  const record = getRecord(request.sessionId, request.terminalId);
  if (record.exitStatus) return record.exitStatus;
  return new Promise((resolve) => record.waiters.add(resolve));
}

export async function killAcpTerminal(
  request: KillTerminalRequest,
): Promise<void> {
  const record = getRecord(request.sessionId, request.terminalId);
  await record.terminal?.kill();
}

export function canStopAcpTerminal(
  sessionId: string,
  terminalId: string,
): boolean {
  const record = records.get(sessionKey(sessionId, terminalId));
  return Boolean(
    record && !record.released && !record.exitStatus && record.terminal,
  );
}

export function subscribeAcpTerminalCapability(
  sessionId: string,
  terminalId: string,
  listener: AcpTerminalCapabilityListener,
): () => void {
  const key = sessionKey(sessionId, terminalId);
  const listeners =
    capabilityListeners.get(key) ?? new Set<AcpTerminalCapabilityListener>();
  listeners.add(listener);
  capabilityListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) capabilityListeners.delete(key);
  };
}

export async function stopAcpTerminal(
  sessionId: string,
  terminalId: string,
): Promise<boolean> {
  if (!canStopAcpTerminal(sessionId, terminalId)) return false;
  await killAcpTerminal({ sessionId, terminalId });
  return true;
}

export async function releaseAcpTerminal(
  request: ReleaseTerminalRequest,
): Promise<void> {
  const key = sessionKey(request.sessionId, request.terminalId);
  const record = getRecord(request.sessionId, request.terminalId);
  if (!record.exitStatus) {
    await record.terminal?.kill();
    if (!record.exitStatus) {
      await new Promise<WaitForTerminalExitResponse>((resolve) =>
        record.waiters.add(resolve),
      );
    }
  }

  // ACP release invalidates the terminal methods, but tool calls that already
  // reference the terminal must keep displaying their captured output.
  externalTerminalInfo.set(key, {
    sessionId: record.sessionId,
    terminalId: record.terminalId,
    cwd: record.cwd,
    title: record.title,
  });
  record.released = true;
  record.terminal = null;
  records.delete(key);
  emitCapabilityChange(key);
  autoOpenDismissed.delete(key);
}

export async function registerExternalAcpTerminal(
  info: ExternalTerminalInfo,
): Promise<void> {
  const key = sessionKey(info.sessionId, info.terminalId);
  const clientHostedRecord = records.get(key);
  if (clientHostedRecord) {
    clientHostedRecord.cwd = info.cwd;
    clientHostedRecord.title = info.title;
    return;
  }

  const existing = externalTerminalInfo.get(key);
  const existingReady = externalTerminalReady.get(key);
  if (existing && existingReady) return existingReady;

  const generation = lifecycleGeneration;
  autoOpenDismissed.delete(key);
  externalTerminalInfo.set(key, info);
  emitCapabilityChange(key);
  const ready = (async () => {
    const { getOrCreateTerminalSession } = await import(
      "@/features/terminal/lib/terminalSessionManager"
    );
    if (generation !== lifecycleGeneration) return;
    const terminal = getOrCreateTerminalSession({
      key,
      cwd: info.cwd,
      labels: {
        startFailed: "Could not connect to agent terminal.",
        stopped: "Terminal view closed",
        exitedWithSignal: (signal) => `Exited by ${signal}`,
      },
      theme: {},
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      external: true,
    });
    terminal.writeOutput(`$ ${info.title}\r\n`);
    terminal.writeOutput(
      `Running in ${info.cwd} · live output is read-only\r\n\r\n`,
    );

    const pending = pendingExternalTerminalEvents.get(key);
    if (pending?.output) terminal.writeOutput(pending.output);
    if (pending?.exitStatus) terminal.finishExternal(pending.exitStatus);
    deletePendingExternalEvents(key);
  })();
  externalTerminalReady.set(key, ready);
  try {
    await ready;
  } catch (error) {
    externalTerminalReady.delete(key);
    externalTerminalInfo.delete(key);
    emitCapabilityChange(key);
    throw error;
  }
}

export async function appendExternalAcpTerminalOutput(
  sessionId: string,
  terminalId: string,
  data: string,
): Promise<void> {
  const key = sessionKey(sessionId, terminalId);
  const ready = externalTerminalReady.get(key);
  if (!ready) {
    const pending = pendingExternalEvents(key);
    pending.output = trimToByteLimit(
      pending.output + data,
      PENDING_EXTERNAL_OUTPUT_BYTE_LIMIT,
    );
    return;
  }
  await ready;
  const { getTerminalSession } = await import(
    "@/features/terminal/lib/terminalSessionManager"
  );
  getTerminalSession(key)?.writeOutput(data);
}

export async function finishExternalAcpTerminal(
  sessionId: string,
  terminalId: string,
  status: { exitCode: number | null; signal: string | null },
): Promise<void> {
  const key = sessionKey(sessionId, terminalId);
  const ready = externalTerminalReady.get(key);
  if (!ready) {
    pendingExternalEvents(key).exitStatus = status;
    return;
  }
  await ready;
  const { getTerminalSession } = await import(
    "@/features/terminal/lib/terminalSessionManager"
  );
  getTerminalSession(key)?.finishExternal(status);
}

export function hasAcpTerminal(sessionId: string, terminalId: string): boolean {
  const key = sessionKey(sessionId, terminalId);
  return records.has(key) || externalTerminalInfo.has(key);
}

export function requestOpenAcpTerminal(
  sessionId: string,
  terminalId: string,
  { automatic = false }: { automatic?: boolean } = {},
): boolean {
  const key = sessionKey(sessionId, terminalId);
  if (automatic && autoOpenDismissed.has(key)) return false;
  if (!automatic) autoOpenDismissed.delete(key);

  const record = records.get(key);
  const info = externalTerminalInfo.get(key);
  const request: AcpTerminalOpenRequest | null = info
    ? { ...info, focus: !automatic }
    : record
      ? {
          sessionId: record.sessionId,
          terminalId: record.terminalId,
          cwd: record.cwd,
          title: record.title,
          focus: !automatic,
        }
      : null;
  if (!request) return false;
  for (const listener of openListeners) listener(request);
  return true;
}

export function closeAcpTerminalDisplay(
  sessionId: string,
  terminalId: string,
): void {
  autoOpenDismissed.add(sessionKey(sessionId, terminalId));
}

export function subscribeAcpTerminalOpenRequests(
  listener: AcpTerminalOpenListener,
): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

export function teardownAcpTerminals(): Promise<void> {
  lifecycleGeneration += 1;
  const ownedRecords = [...records.values()];
  const managedKeys = new Set([
    ...ownedRecords.map((record) =>
      sessionKey(record.sessionId, record.terminalId),
    ),
    ...externalTerminalInfo.keys(),
    ...externalTerminalReady.keys(),
  ]);

  for (const record of ownedRecords) {
    finishRecord(record, CONNECTION_CLOSED_STATUS);
    record.released = true;
  }
  records.clear();
  externalTerminalInfo.clear();
  externalTerminalReady.clear();
  for (const key of managedKeys) emitCapabilityChange(key);
  autoOpenDismissed.clear();
  for (const key of pendingExternalTerminalEvents.keys()) {
    deletePendingExternalEvents(key);
  }
  clearAgentTerminalTabStates();

  const teardown = (async () => {
    for (const record of ownedRecords) {
      void record.terminal?.kill().catch(() => undefined);
    }
    const { getTerminalSession, stopTerminalSession } = await import(
      "@/features/terminal/lib/terminalSessionManager"
    );
    const managedSessions = [...managedKeys].map(
      (key) => [key, getTerminalSession(key)] as const,
    );
    for (const [key, expectedSession] of managedSessions) {
      if (expectedSession && getTerminalSession(key) === expectedSession) {
        stopTerminalSession(key);
      }
    }
    for (const record of ownedRecords) record.terminal = null;
  })();
  return teardown;
}
