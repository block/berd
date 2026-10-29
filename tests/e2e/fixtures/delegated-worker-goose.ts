import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { buildInitScript } from "./tauri-mock";

export type Scenario = "normal" | "action-limit" | "busy";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP address");
  return address.port;
}

export const test = base.extend<{
  realGoose: {
    scenario: Scenario;
    requests: { method: string; url: string; body: Record<string, unknown> }[];
    frames: {
      direction: "sent" | "received";
      message: Record<string, unknown>;
    }[];
    socketErrors: string[];
  };
}>({
  realGoose: async ({ page, baseURL }, use, testInfo) => {
    // Bind the real ACP server binary to its matching source checkout and commit.
    const binary = process.env.GOOSE_BIN;
    const source = process.env.GOOSE_SOURCE_DIR;
    const expected = process.env.GOOSE_EXPECTED_COMMIT;
    if (!binary || !isAbsolute(binary) || !source || !expected) {
      throw new Error(
        "Set absolute GOOSE_BIN, GOOSE_SOURCE_DIR and full GOOSE_EXPECTED_COMMIT to a Goose binary built with acp-http and its matching source checkout.",
      );
    }
    const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(commit, "Goose source must match the explicit test pin").toBe(
      expected,
    );
    execFileSync("git", ["-C", source, "diff", "--exit-code", "HEAD"], {
      stdio: "pipe",
    });
    const digest = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    console.log(
      `[real-goose] source=${commit} binary=${binary} sha256=${digest}`,
    );

    const root = await mkdtemp(join(tmpdir(), "berd-capacity-"));
    await mkdir(join(root, "goose artifacts"));
    const harness = {
      scenario: "normal" as Scenario,
      requests: [] as {
        method: string;
        url: string;
        body: Record<string, unknown>;
      }[],
      frames: [] as {
        direction: "sent" | "received";
        message: Record<string, unknown>;
      }[],
      socketErrors: [] as string[],
    };
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { raw };
      }
      harness.requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
      });
      console.log(
        `[mock-provider] ${req.method} ${req.url} model=${body.model} stream=${body.stream} scenario=${harness.scenario}`,
      );
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-4.1", object: "model", owned_by: "openai" }],
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end("Unexpected mock provider route");
        return;
      }
      const messages = body.messages as { role: string; content: unknown }[];
      const worker = JSON.stringify(messages).includes("Subagent ID:");
      const delegated = messages.some((message) => message.role === "tool");
      const wake = messages.some(
        (message) =>
          message.role === "user" &&
          (JSON.stringify(message.content).includes(
            "Worker ended with status",
          ) ||
            JSON.stringify(message.content).includes(
              "Worker reached its action limit",
            )),
      );
      const tools = !worker && !delegated && !wake;
      const delta =
        worker && harness.scenario === "action-limit"
          ? {
              role: "assistant",
              content: "Worker action-limit checkpoint",
              tool_calls: [
                {
                  index: 0,
                  id: "peek-call",
                  type: "function",
                  function: { name: "load", arguments: "{}" },
                },
              ],
            }
          : tools
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "worker-call",
                    type: "function",
                    function: {
                      name: "delegate",
                      arguments: JSON.stringify({
                        async: true,
                        instructions: "Finish worker-checkpoint-browser",
                        max_turns: harness.scenario === "action-limit" ? 1 : 3,
                        extensions: [],
                      }),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: worker
                  ? "Worker browser checkpoint"
                  : wake
                    ? "Parent resumed automatically"
                    : "Parent is idle",
              };
      const chunk = {
        id: randomUUID(),
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            delta,
            finish_reason:
              tools || (worker && harness.scenario === "action-limit")
                ? "tool_calls"
                : "stop",
          },
        ],
      };
      // Hold worker response until after the initial parent prompt has settled.
      if (worker)
        await new Promise((resolve) =>
          setTimeout(resolve, harness.scenario === "busy" ? 500 : 2000),
        );
      if (!worker && delegated && !wake && harness.scenario === "busy")
        await new Promise((resolve) => setTimeout(resolve, 3500));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n`);
    });
    let child: ReturnType<typeof spawn> | undefined;
    let logs = "";
    try {
      const providerPort = await listen(provider);
      const reservation = createServer();
      const port = await listen(reservation);
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const secret = "capacity-browser-test-only";
      child = spawn(
        binary,
        [
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--platform",
          "desktop",
          "--allowed-origin",
          new URL(baseURL ?? "http://127.0.0.1:4173").origin,
        ],
        {
          cwd: root,
          env: {
            // Do not inherit real provider credentials, extensions or user configuration.
            PATH: "/usr/bin:/bin",
            HOME: root,
            TMPDIR: tmpdir(),
            GOOSE_PATH_ROOT: root,
            GOOSE_PROVIDER: "openai",
            GOOSE_MODEL: "gpt-4.1",
            GOOSE_SERVER__SECRET_KEY: secret,
            OPENAI_API_KEY: "sk-capacity-test-only",
            OPENAI_HOST: `http://127.0.0.1:${providerPort}`,
            OPENAI_BASE_PATH: "v1/chat/completions",
            RUST_LOG: "info",
            GOOSE_DISABLE_SESSION_NAMING: "true",
            GOOSE_MOIM_DISABLE: "true",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.on("error", (error) => {
        logs += `spawn error: ${error.message}\n`;
      });
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk) => {
          logs += chunk.toString();
        });
      const health = `http://127.0.0.1:${port}/health`;
      await expect
        .poll(
          async () => {
            if (child?.exitCode != null)
              throw new Error(`goose serve exited ${child.exitCode}:\n${logs}`);
            try {
              return (
                await fetch(health, { signal: AbortSignal.timeout(1000) })
              ).ok;
            } catch {
              return false;
            }
          },
          {
            timeout: 30_000,
            message: `Waiting for actual goose serve at ${health}`,
          },
        )
        .toBe(true);
      page.on("pageerror", (error) =>
        console.log(`[browser error] ${error.stack ?? error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          console.log(`[browser console] ${message.text()}`);
      });
      page.on("websocket", (socket) => {
        socket.on("socketerror", (error) => harness.socketErrors.push(error));
        for (const direction of ["sent", "received"] as const) {
          socket.on(
            direction === "sent" ? "framesent" : "framereceived",
            (frame) => {
              try {
                const message = JSON.parse(String(frame.payload));
                harness.frames.push({ direction, message });
                if (message.error)
                  console.log(`[real-acp] ${JSON.stringify(message)}`);
              } catch {
                /* Ignore non-JSON WebSocket frames. */
              }
            },
          );
        }
      });
      await page.addInitScript({
        content: buildInitScript({
          realAcpUrl: `ws://127.0.0.1:${port}/acp?token=${secret}`,
          homeDir: root,
          modelId: "gpt-4.1",
          personas: [],
          skills: [],
          projects: [],
        }),
      });
      await use(harness);
    } finally {
      await testInfo.attach("real-goose-evidence", {
        body: JSON.stringify(
          {
            requests: harness.requests,
            frames: harness.frames,
            socketErrors: harness.socketErrors,
            logs,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      if (testInfo.status !== testInfo.expectedStatus)
        console.log(
          `[real-goose failure]\n${logs}\n${JSON.stringify(harness, null, 2)}`,
        );
      if (child?.pid && child.exitCode == null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
        await exited;
        clearTimeout(timer);
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
});

export { expect };
