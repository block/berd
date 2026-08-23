import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PocketVoiceStatus } from "../api/pocketVoice";
import type { MacSpeechStatus } from "../api/macSpeech";
import type { SiriVoiceStatus } from "../api/siriVoice";
import {
  isVoiceSetupReady,
  refreshStableVoiceSetupReadiness,
  refreshVoiceSetupReadiness,
} from "./voiceSetupReadiness";

const mockGetPocketVoiceStatus = vi.hoisted(() => vi.fn());
const mockGetMacSpeechStatus = vi.hoisted(() => vi.fn());
const mockGetSiriVoiceStatus = vi.hoisted(() => vi.fn());

vi.mock("../api/pocketVoice", () => ({
  getPocketVoiceStatus: mockGetPocketVoiceStatus,
}));
vi.mock("../api/macSpeech", () => ({
  getMacSpeechStatus: mockGetMacSpeechStatus,
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

const macSpeech = {
  supported: true,
  localeSupported: true,
  modelInstalled: true,
} as MacSpeechStatus;

describe("voice setup readiness", () => {
  beforeEach(() => {
    mockGetPocketVoiceStatus.mockReset();
    mockGetMacSpeechStatus.mockReset();
    mockGetSiriVoiceStatus.mockReset();
  });

  it("requires Parakeet and Pocket for the Pocket backend", () => {
    expect(isVoiceSetupReady(pocket, null, null, "parakeet", "pocket")).toBe(
      true,
    );
    expect(
      isVoiceSetupReady(
        { ...pocket, parakeetInstalled: false },
        null,
        null,
        "parakeet",
        "pocket",
      ),
    ).toBe(false);
  });

  it("requires Parakeet and an installed selected Siri voice", () => {
    expect(isVoiceSetupReady(pocket, null, siri, "parakeet", "siri")).toBe(
      true,
    );
    expect(
      isVoiceSetupReady(
        pocket,
        null,
        { ...siri, selectedVoiceInstalled: false },
        "parakeet",
        "siri",
      ),
    ).toBe(false);
  });

  it("refreshes Pocket readiness without querying Siri", async () => {
    mockGetPocketVoiceStatus.mockResolvedValue(pocket);

    await expect(
      refreshVoiceSetupReadiness("parakeet", "pocket", "en-US"),
    ).resolves.toBe(true);
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledOnce();
    expect(mockGetSiriVoiceStatus).not.toHaveBeenCalled();
  });

  it("refreshes Siri readiness for the selected language", async () => {
    mockGetPocketVoiceStatus.mockResolvedValue(pocket);
    mockGetSiriVoiceStatus.mockResolvedValue(siri);

    await expect(
      refreshVoiceSetupReadiness("parakeet", "siri", "en-AU"),
    ).resolves.toBe(true);
    expect(mockGetPocketVoiceStatus).toHaveBeenCalledOnce();
    expect(mockGetSiriVoiceStatus).toHaveBeenCalledWith("en-AU");
  });

  it("uses native macOS speech readiness instead of Parakeet when selected", async () => {
    mockGetPocketVoiceStatus.mockResolvedValue({
      ...pocket,
      parakeetInstalled: false,
    });
    mockGetMacSpeechStatus.mockResolvedValue(macSpeech);

    await expect(
      refreshVoiceSetupReadiness("macos", "pocket", "en-US"),
    ).resolves.toBe(true);
    expect(mockGetMacSpeechStatus).toHaveBeenCalledOnce();
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
      inputBackend: "parakeet" | "macos";
      outputBackend: "pocket" | "siri";
      siriLanguage: string;
      revision: number;
    } = {
      inputBackend: "parakeet",
      outputBackend: "pocket",
      siriLanguage: "en-US",
      revision: 0,
    };

    const readiness = refreshStableVoiceSetupReadiness(() => selection);
    selection = {
      inputBackend: "parakeet",
      outputBackend: "siri",
      siriLanguage: "en-AU",
      revision: 1,
    };
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
      inputBackend: "parakeet" as const,
      outputBackend: "pocket" as const,
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
