import {
  beforeEach as beforeSupportedMemory,
  afterEach as afterSupportedMemory,
  vi as memoryEnv,
} from "vitest";
beforeSupportedMemory(() => memoryEnv.stubEnv("VITE_MEMORY_SUPPORTED", "1"));
afterSupportedMemory(() => memoryEnv.unstubAllEnvs());
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  loadMeFile: vi.fn(),
  createMeFile: vi.fn(),
  saveMeFile: vi.fn(),
  listTopics: vi.fn(),
  createTopic: vi.fn(),
  readMemoryPolicy: vi.fn(),
  writeMemoryPolicy: vi.fn(),
  refreshProposals: vi.fn(),
  proposalsError: null as string | null,
}));
vi.mock("../../lib/meFile", () => ({
  loadMeFile: mocks.loadMeFile,
  createMeFile: mocks.createMeFile,
  saveMeFile: mocks.saveMeFile,
  ME_FILE_TEMPLATE: "# Me",
}));
vi.mock("../../lib/meTopics", () => ({
  listTopics: mocks.listTopics,
  createTopic: mocks.createTopic,
  saveTopic: vi.fn(),
}));
vi.mock("../../lib/memoryPolicyFile", () => ({
  readMemoryPolicy: mocks.readMemoryPolicy,
  writeMemoryPolicy: mocks.writeMemoryPolicy,
}));
vi.mock("../../hooks/useMemoryProposals", () => ({
  useMemoryProposals: () => ({
    proposals: [],
    approve: vi.fn(),
    decline: vi.fn(),
    error: mocks.proposalsError,
    refresh: mocks.refreshProposals,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
import { MeSettings } from "../MeSettings";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.proposalsError = null;
  mocks.loadMeFile.mockResolvedValue({
    status: "missing",
    path: "/fixture/.me/me.md",
    displayPath: "~/.me/me.md",
  });
  mocks.listTopics.mockResolvedValue([]);
  mocks.readMemoryPolicy.mockResolvedValue({ enabled: true });
  mocks.writeMemoryPolicy.mockResolvedValue(true);
});
it("does not initialize or seed from a read even when policy is enabled", async () => {
  render(<MeSettings />);
  await screen.findByRole("button", { name: "Import Markdown" });
  expect(mocks.createMeFile).not.toHaveBeenCalled();
  expect(mocks.saveMeFile).not.toHaveBeenCalled();
});
it("shows locked or legacy storage as an error, never an empty editable document", async () => {
  mocks.loadMeFile.mockRejectedValue(new Error("locked"));
  mocks.listTopics.mockRejectedValue(new Error("locked"));
  render(<MeSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The memory encryption key is unavailable",
  );
  expect(
    screen.queryByRole("button", { name: "Import Markdown" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("me.noTopics")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "me.addTopicAction" }),
  ).toBeDisabled();
  expect(mocks.createMeFile).not.toHaveBeenCalled();
});
it("provides a refresh action to recover from a locked store", async () => {
  const user = userEvent.setup();
  mocks.loadMeFile.mockRejectedValueOnce(new Error("locked"));
  render(<MeSettings />);
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "me.refresh" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Import Markdown" }),
  ).toBeEnabled();
});
it("reports a policy write failure without seeding or changing the switch", async () => {
  const user = userEvent.setup();
  mocks.readMemoryPolicy.mockResolvedValue({ enabled: false });
  mocks.writeMemoryPolicy.mockResolvedValue(false);
  render(<MeSettings />);
  await waitFor(() => expect(mocks.readMemoryPolicy).toHaveBeenCalled());
  await user.click(screen.getByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't change the memory setting",
  );
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(mocks.createMeFile).not.toHaveBeenCalled();
});

it.each([
  [
    "Memory encryption key is missing; refusing to replace it",
    "The encryption key for this memory store is missing",
  ],
  [
    "Existing memory data requires explicit migration; plaintext was not read or changed",
    "needs an explicit migration",
  ],
  [
    "Memory authentication failed; record or key is damaged",
    "The store may be damaged or unavailable",
  ],
])("shows a safe, actionable storage category for %s", async (message, copy) => {
  mocks.loadMeFile.mockRejectedValue(new Error(message));
  render(<MeSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  expect(screen.queryByText(message)).not.toBeInTheDocument();
});
it("distinguishes an initialization failure after opting in", async () => {
  mocks.readMemoryPolicy.mockResolvedValue({ enabled: false });
  mocks.createMeFile.mockRejectedValue(new Error("private failure detail"));
  const user = userEvent.setup();
  render(<MeSettings />);
  await screen.findByText("me.offBanner.description");
  await user.click(screen.getByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't initialize encrypted memory",
  );
  expect(screen.queryByText("private failure detail")).not.toBeInTheDocument();
});
it("shows unreadable proposal queues and refreshes them explicitly", async () => {
  mocks.proposalsError = "unavailable";
  const user = userEvent.setup();
  render(<MeSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't read encrypted memory",
  );
  await user.click(screen.getAllByRole("button", { name: "me.refresh" })[0]);
  expect(mocks.refreshProposals).toHaveBeenCalledOnce();
});

it("offers explicit initialization retry without initializing on refresh", async () => {
  const user = userEvent.setup();
  mocks.loadMeFile.mockRejectedValueOnce(
    new Error("Memory store is not initialized"),
  );
  mocks.listTopics.mockRejectedValueOnce(
    new Error("Memory store is not initialized"),
  );
  mocks.createMeFile.mockResolvedValue({
    status: "present",
    path: "/fixture/.me/me.md",
    displayPath: "~/.me/me.md",
    contents: "# Me",
  });
  render(<MeSettings />);
  const retry = await screen.findByRole("button", {
    name: "me.retryInitialization",
  });
  expect(mocks.createMeFile).not.toHaveBeenCalled();
  await user.click(retry);
  await waitFor(() => expect(mocks.createMeFile).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("renders a static unsupported direct route despite stale enabled policy", () => {
  vi.stubEnv("VITE_MEMORY_SUPPORTED", "0");
  render(<MeSettings />);
  expect(screen.getByText("me.unsupported")).toBeInTheDocument();
  expect(mocks.loadMeFile).not.toHaveBeenCalled();
  expect(mocks.listTopics).not.toHaveBeenCalled();
  expect(mocks.readMemoryPolicy).not.toHaveBeenCalled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});
