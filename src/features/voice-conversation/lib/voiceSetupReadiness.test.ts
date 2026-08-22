import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { SiriVoiceStatus } from "../api/siriVoice";
import {
  isVoiceSetupReady,
  refreshStableVoiceSetupReadiness,
  refreshVoiceSetupReadiness,
} from "./voiceSetupReadiness";

const mockGetPocketVoiceStatus = vi.hoisted(() => vi.fn());
const mockGetSiriVoiceStatus = vi.hoisted(() => vi.fn());

vi.mock("../api/pocketVoice", () => ({
  getPocketVoiceStatus: mockGetPocketVoiceStatus,
}));
vi.mock("../api/siriVoice", () => ({
  getSiriVoiceStatus: mockGetSiriVoiceStatus,
}));

const pocket = {
  installed: true,
  pocketInstalled: true,
  parakeetInstalled: true,
} as PocketVoiceStatus;

const siri = {
  supported: true,
  selectedVoice: { name: "Aaron", language: "en-US" },
  selectedVoiceInstalled: true,
} as SiriVoiceStatus;

describe("voice setup readiness", () => {
  beforeEach(() => {
    mockGetPocketVoiceStatus.mockReset();
    mockGetSiriVoiceStatus.mockReset();
  });

  it("requires Parakeet and Pocket for the Pocket backend", () => {
    expect(isVoiceSetupReady(pocket, null, "pocket")).toBe(true);
    expect(
      isVoiceSetupReady(
        { ...pocket, parakeetInstalled: false },
        null,
        "pocket",
      ),
    ).toBe(false);
  });

  it("requires Parakeet and an installed selected Siri voice", () => {
    expect(isVoiceSetupReady(pocket, siri, "siri")).toBe(true);
    expect(
      isVoiceSetupReady(
        pocket,
        { ...siri, selectedVoiceInstalled: false },
        "siri",
      ),
    ).toBe(false);
  });

  it("refreshes Pocket readiness without querying Siri", async () => {
    mockGetPocketVoiceStatus.mockResolvedValue(pocket);

    await expect(refreshVoiceSetupReadiness("pocket", "en-US")).resolves.toBe(
      true,
    );
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledOnce();
    expect(mockGetSiriVoiceStatus).not.toHaveBeenCalled();
  });

  it("refreshes Siri readiness for the selected language", async () => {
    mockGetPocketVoiceStatus.mockResolvedValue(pocket);
    mockGetSiriVoiceStatus.mockResolvedValue(siri);

    await expect(refreshVoiceSetupReadiness("siri", "en-AU")).resolves.toBe(
      true,
    );
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledOnce();
    expect(mockGetSiriVoiceStatus).toHaveBeenCalledWith("en-AU");
  });

  it("rechecks readiness when the selected backend changes during refresh", async () => {
    let resolvePocket!: (status: PocketVoiceStatus) => void;
    const firstPocket = new Promise<PocketVoiceStatus>((resolve) => {
      resolvePocket = resolve;
    });
    mockGetPocketVoiceStatus
      .mockReturnValueOnce(firstPocket)
      .mockResolvedValueOnce(pocket);
    mockGetSiriVoiceStatus.mockResolvedValue(siri);
    let selection: {
      backend: "pocket" | "siri";
      siriLanguage: string;
      revision: number;
    } = { backend: "pocket", siriLanguage: "en-US", revision: 0 };

    const readiness = refreshStableVoiceSetupReadiness(() => selection);
    selection = { backend: "siri", siriLanguage: "en-AU", revision: 1 };
    resolvePocket({ ...pocket, pocketInstalled: false });

    await expect(readiness).resolves.toBe(true);
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledTimes(2);
    expect(mockGetSiriVoiceStatus).toHaveBeenCalledWith("en-AU");
  });

  it("rechecks readiness after an A-to-B-to-A selection change", async () => {
    let resolveFirst!: (status: PocketVoiceStatus) => void;
    const firstPocket = new Promise<PocketVoiceStatus>((resolve) => {
      resolveFirst = resolve;
    });
    mockGetPocketVoiceStatus
      .mockReturnValueOnce(firstPocket)
      .mockResolvedValueOnce(pocket);
    let selection = {
      backend: "pocket" as const,
      siriLanguage: "en-US",
      revision: 0,
    };

    const readiness = refreshStableVoiceSetupReadiness(() => selection);
    selection = { ...selection, revision: 2 };
    resolveFirst({ ...pocket, pocketInstalled: false });

    await expect(readiness).resolves.toBe(true);
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledTimes(2);
  });
});
