import { getClient } from "@/shared/api/acpConnection";
import { shareInFlight } from "@/shared/lib/shareInFlight";

/**
 * Persisted goose default provider/model. A plain call always fetches; the
 * default-provider readiness store passes `{ coalesce: true }` from its startup
 * and mount-time refreshes, where independent hooks (and StrictMode
 * double-mounts) would otherwise each issue their own read.
 */
export const readGooseDefaults = shareInFlight(async () => {
  const client = await getClient();
  return client.goose.GooseUnstableDefaultsRead({});
});
