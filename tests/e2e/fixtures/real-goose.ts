import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { buildInitScript } from "./tauri-mock";

export type Scenario =
  | "normal"
  | "http503"
  | "nested"
  | "flat"
  | "untyped"
  | "eof"
  | "partial-eof";

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
    // An explicit feature-source pin is required, not the release sidecar or a mock ACP server.
    const binary = process.env.GOOSE_BIN;
    const source = process.env.GOOSE_SOURCE_DIR;
    const expected = process.env.GOOSE_EXPECTED_COMMIT;
    if (!binary || !isAbsolute(binary) || !source || !expected) {
      throw new Error(
        "Set absolute GOOSE_BIN, GOOSE_SOURCE_DIR and full GOOSE_EXPECTED_COMMIT to the feature build (goose-cli with acp-http). Build on Blox, not macOS.",
      );
    }
    const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(
      commit,
      "Goose feature source must match the explicit test pin",
    ).toBe(expected);
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
            data: [{ id: "gpt-5.2", object: "model", owned_by: "openai" }],
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404).end("Unexpected mock provider route");
        return;
      }
      if (harness.scenario === "http503") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "service_unavailable_error",
              code: "server_is_overloaded",
              message:
                "Our servers are currently overloaded. Please try again later.",
              param: null,
            },
          }),
        );
        return;
      }
      // Non-streaming auxiliary requests (for example titles) must not consume a scripted turn.
      const text = "Capacity control reply";
      // Provider identities are unique per request, including retries and title requests.
      const responseId = `resp_${randomUUID()}`;
      const messageId = `msg_${randomUUID()}`;
      const response = {
        id: responseId,
        object: "response",
        created_at: 1737368310,
        model: "gpt-5.2",
        status: "completed",
        output: [
          {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      };
      if (!body.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      let sequence = 0;
      const event = (value: Record<string, unknown>) =>
        res.write(
          `data: ${JSON.stringify({ sequence_number: ++sequence, ...value })}\n\n`,
        );
      event({
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      });
      if (harness.scenario === "normal" || harness.scenario === "partial-eof") {
        event({
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta:
            harness.scenario === "normal"
              ? text
              : "Partial capacity reply survives",
        });
      }
      if (harness.scenario === "normal") {
        event({ type: "response.completed", response });
      } else if (harness.scenario === "nested") {
        event({
          type: "error",
          error: {
            type: "service_unavailable_error",
            code: "server_is_overloaded",
            message:
              "Our servers are currently overloaded. Please try again later.",
            param: null,
          },
        });
      } else if (harness.scenario === "flat") {
        event({
          type: "error",
          code: "server_is_overloaded",
          message:
            "Our servers are currently overloaded. Please try again later.",
          param: null,
        });
      } else if (harness.scenario === "untyped") {
        event({
          error: {
            type: "service_unavailable_error",
            code: "server_is_overloaded",
            message:
              "Our servers are currently overloaded. Please try again later.",
            param: null,
          },
        });
      }
      // Deliberately no terminal event or [DONE] on the EOF cases.
      res.end();
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
            GOOSE_MODEL: "gpt-5.2",
            GOOSE_SERVER__SECRET_KEY: secret,
            OPENAI_API_KEY: "sk-capacity-test-only",
            OPENAI_HOST: `http://127.0.0.1:${providerPort}`,
            OPENAI_BASE_PATH: "v1/responses",
            RUST_LOG: "info",
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
          modelId: "gpt-5.2",
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
