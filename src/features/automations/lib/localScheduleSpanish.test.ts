import { describe, expect, it } from "vitest";
import esAutomations from "@/shared/i18n/locales/es/automations.json";

describe("Spanish local schedule copy", () => {
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
    ["recoverCron", "Recuperar la programación de {{id}}"],
    ["recoverAction", "Recuperar programación"],
    ["uncertainTitle", "Es necesario verificar el temporizador"],
    ["editCron", "Editar la expresión cron de {{id}}"],
    ["cronLabel", "Expresión cron de {{id}}"],
    ["reconcilingSchedule", "Comprobando el estado actual de la programación…"],
    ["updateError", "No se pudo actualizar la programación de Goose."],
    [
      "updateTimeout",
      "La actualización de la programación agotó el tiempo de espera. Se cerró su conexión y se desconoce el estado del temporizador. Verifica la programación en Goose antes de recuperarla con otra expresión.",
    ],
    [
      "listTimeout",
      "La actualización de la lista agotó el tiempo de espera. Actualiza para reintentar; ver una programación en la lista no verifica su temporizador.",
    ],
    [
      "connectionChanged",
      "La conexión de Goose cambió antes de confirmar la solicitud de programación. Actualiza y verifica la programación antes de reintentar.",
    ],
    [
      "updateFailureCaution",
      "Es posible que el programador haya quitado el temporizador anterior si la actualización falló inesperadamente. Verifica la programación en Goose antes de depender de ella.",
    ],
    [
      "refreshAfterUpdateError",
      "La actualización de la lista también falló, así que se desconoce el estado actual de la programación.",
    ],
    [
      "failedUpdateRetry",
      "Esta misma expresión ya falló. No la reintentes: es posible que Goose haya quitado el temporizador anterior. Verifica la programación o prueba otra expresión válida.",
    ],
    [
      "changedElsewhere",
      "Esta programación cambió mientras la editabas. Cancela y vuelve a abrirla para revisar el valor más reciente.",
    ],
  ] as const)("preserves accented copy for %s", (key, expected) => {
    expect(esAutomations.localSchedules[key]).toBe(expected);
  });

  it("preserves accented cron guidance", () => {
    for (const word of [
      "día-del-mes",
      "día-de-la-semana",
      "numéricos",
      "días",
      "más",
      "comodín",
      "podría",
      "actualización",
      "programación",
      "después",
    ]) {
      expect(esAutomations.localSchedules.cronHelp).toContain(word);
    }
  });

  it.each([
    ["fieldCount", "Ingresa una expresión cron de cinco o seis campos."],
    [
      "unsupported",
      "La expresión no es válida o usa una sintaxis que este editor no puede actualizar de forma segura. La programación existente no cambió.",
    ],
    [
      "safeWindow",
      "Usa un comodín para el mes y un comodín en día-del-mes o día-de-la-semana. Goose exige que ambos campos de día coincidan si ninguno es comodín y los combina con AND.",
    ],
  ] as const)("preserves accented validation for %s", (key, expected) => {
    expect(esAutomations.localSchedules.validation[key]).toBe(expected);
  });

  it("retains the active and unknown last-run labels", () => {
    expect(esAutomations.localSchedules.active).toBe("Activa");
    expect(esAutomations.localSchedules.unknownLastRun).toBe("Desconocida");
  });
});
