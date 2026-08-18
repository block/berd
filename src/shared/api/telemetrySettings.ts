import { z } from "zod/v4";
import { invokeWithStartupRetry } from "./invokeWithStartupRetry";

// Thin wrapper over the Rust-owned telemetry consent setting
// (`telemetry-settings.json` in the app-data dir). The renderer never reads
// or writes the file itself: the Rust side owns it so the native export gate
// in `export_otel_logs` can enforce the same value the UI shows. The startup
// retry matters here more than anywhere: telemetry initializes at renderer
// boot, exactly the window where `TelemetryAuthState` may not be managed yet.
const telemetrySettingsSchema = z.object({ enabled: z.boolean() });

export type TelemetrySettings = z.infer<typeof telemetrySettingsSchema>;

export async function getTelemetrySettings(): Promise<TelemetrySettings> {
  return telemetrySettingsSchema.parse(
    await invokeWithStartupRetry("get_telemetry_settings"),
  );
}

export async function setTelemetryEnabled(
  enabled: boolean,
): Promise<TelemetrySettings> {
  return telemetrySettingsSchema.parse(
    await invokeWithStartupRetry("set_telemetry_enabled", { enabled }),
  );
}
