import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listLocalSchedules } from "@/features/automations/api/localSchedules";
import { formatDate, i18n } from "@/shared/i18n";
import esAutomations from "@/shared/i18n/locales/es/automations.json";
import { LocalSchedulesPanel } from "@/features/automations/ui/LocalSchedulesPanel";

vi.mock("@/features/automations/api/localSchedules", () => ({
  LOCAL_SCHEDULES_QUERY_KEY: ["local-goose-schedules"],
  LOCAL_SCHEDULES_REFETCH_INTERVAL_MS: 15_000,
  listLocalSchedules: vi.fn(),
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalSchedulesPanel />
    </QueryClientProvider>,
  );
}

const schedule = {
  id: "weekday-report",
  source: "/tmp/weekday-report.yaml",
  cron: "0 9 * * 1-5",
  paused: false,
  currentlyRunning: true,
  lastRun: "2026-11-04T09:00:00Z",
};

describe("Spanish local schedule list", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await i18n.changeLanguage("es");
    await i18n.loadNamespaces("automations");
    vi.mocked(listLocalSchedules).mockResolvedValue([schedule]);
  });

  it.each([
    [
      "loadErrorDescription",
      "El programador local no está disponible o Goose no está conectado.",
    ],
    [
      "refreshError",
      "No se pudieron actualizar las programaciones: {{error}}. Se muestra la última lista cargada.",
    ],
    ["emptyTitle", "Aún no hay programaciones locales"],
    [
      "emptyBody",
      "Las programaciones que crees en Goose aparecerán aquí. Usa la CLI de Goose u otro cliente de Goose para programar y configurar recetas.",
    ],
    ["running", "En ejecución"],
    ["lastRun", "Última ejecución: {{time}}"],
  ] as const)("preserves accented %s copy", (key, expected) => {
    expect(esAutomations.localSchedules[key]).toBe(expected);
  });

  it("renders the localized initial error fallback", async () => {
    vi.mocked(listLocalSchedules).mockRejectedValue({});
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El programador local no está disponible o Goose no está conectado.",
    );
  });

  it("renders the localized empty state", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([]);
    renderPanel();
    expect(
      await screen.findByText("Aún no hay programaciones locales"),
    ).toBeInTheDocument();
    expect(screen.getByText(/aparecerán aquí/)).toBeInTheDocument();
  });

  it("renders running and locale-formatted last-run labels", async () => {
    renderPanel();
    expect(await screen.findByText("En ejecución")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Última ejecución: ${formatDate(schedule.lastRun, { dateStyle: "medium", timeStyle: "short" }, "es")}`,
      ),
    ).toBeInTheDocument();
  });

  it("keeps the last list with an accented refresh error", async () => {
    vi.mocked(listLocalSchedules)
      .mockResolvedValueOnce([schedule])
      .mockRejectedValueOnce(new Error("sin conexión"));
    renderPanel();
    await screen.findByText(schedule.id);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(
      await screen.findByText(
        "No se pudieron actualizar las programaciones: sin conexión. Se muestra la última lista cargada.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(schedule.id)).toBeInTheDocument();
  });
});
