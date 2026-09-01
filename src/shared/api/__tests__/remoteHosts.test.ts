import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_HOST_GOOSE_PATH_STORAGE_KEY } from "@/features/remoteHosts/lib/gooseBinaryOverride";
import {
  checkRemoteHost,
  connectRemoteHost,
  disconnectRemoteHost,
  shutdownRemoteHost,
} from "@/shared/api/remoteHosts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

function persistOverride(byHost: Record<string, string>): void {
  window.localStorage.setItem(
    REMOTE_HOST_GOOSE_PATH_STORAGE_KEY,
    JSON.stringify(byHost),
  );
}

describe("remote host goose binary override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it("sends the persisted override as goosePath on connect", async () => {
    persistOverride({ devbox: "~/src/goose/target/release/goose" });

    await connectRemoteHost("devbox");

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_connect", {
      host: "devbox",
      goosePath: "~/src/goose/target/release/goose",
    });
  });

  it("sends a null goosePath for hosts without an override", async () => {
    persistOverride({ other: "/opt/goose/bin/goose" });

    await connectRemoteHost("devbox");

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_connect", {
      host: "devbox",
      goosePath: null,
    });
  });

  it("probes the override binary in the doctor check", async () => {
    persistOverride({ devbox: "/opt/goose/bin/goose" });
    mockedInvoke.mockResolvedValue([
      {
        binary: "goose",
        found: true,
        version: "goose 2.0.0",
        path: "/opt/goose/bin/goose",
      },
    ]);

    const probes = await checkRemoteHost("devbox");

    expect(mockedInvoke).toHaveBeenCalledWith("check_remote_host", {
      host: "devbox",
      goosePath: "/opt/goose/bin/goose",
    });
    expect(probes[0].path).toBe("/opt/goose/bin/goose");
  });

  it("ignores unusable persisted paths instead of forwarding them", async () => {
    persistOverride({ devbox: "goose" });

    await connectRemoteHost("devbox");

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_connect", {
      host: "devbox",
      goosePath: null,
    });
  });

  it("leaves other remote-host commands untouched", async () => {
    persistOverride({ devbox: "/opt/goose/bin/goose" });

    await disconnectRemoteHost("devbox");

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_disconnect", {
      host: "devbox",
      expectedGeneration: null,
    });
  });

  it("scopes initializer cleanup to its remote generation", async () => {
    await disconnectRemoteHost("devbox", 7);

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_disconnect", {
      host: "devbox",
      expectedGeneration: 7,
    });
  });

  it("scopes a confirmed takeover to the inspected daemon instance", async () => {
    await shutdownRemoteHost("devbox", "instance-token");

    expect(mockedInvoke).toHaveBeenCalledWith("remote_backend_shutdown", {
      host: "devbox",
      expectedInstanceToken: "instance-token",
    });
  });
});
