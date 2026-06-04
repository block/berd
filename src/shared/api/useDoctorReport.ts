import {
  useIsFetching,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import { runDoctor, runDoctorFresh } from "@/shared/api/doctor";

// Single shared cache entry for the full doctor report. Every consumer (the
// Doctor settings page, the AI providers card, the chat agent/model picker)
// reads this one query so a single `run_doctor` is reused across detail pages
// within a settings visit instead of each surface probing independently.
export const DOCTOR_REPORT_QUERY_KEY = ["doctor", "report"] as const;

// Sibling key tracking the slower freshness pass (binary --version probes +
// registry lookups). Driven via `qc.fetchQuery` from `refreshDoctorReportFreshness`
// so React Query sees the pass as in-flight; consumers observe it via
// `useDoctorReportFreshnessFetching`. The result is mirrored back into the main
// `DOCTOR_REPORT_QUERY_KEY` cache so render paths stay on the single shared key.
export const DOCTOR_REPORT_FRESHNESS_QUERY_KEY = [
  "doctor",
  "report",
  "fresh",
] as const;

// Reused within a settings visit; re-runs automatically on later opens.
const DOCTOR_REPORT_STALE_TIME = 30_000;

export function useDoctorReport() {
  return useQuery({
    queryKey: DOCTOR_REPORT_QUERY_KEY,
    queryFn: runDoctor,
    staleTime: DOCTOR_REPORT_STALE_TIME,
    retry: false,
    // Observer mounts must not auto-refetch this query. Refreshes are driven
    // explicitly: `SettingsView` mount calls `refreshDoctorReportFreshness`,
    // and `rerunDoctorReport` busts both keys on user-initiated rerun. With
    // `refetchOnMount: true`, a late-mounting observer (e.g.
    // `ProvidersSettings`'s `useDoctorReport` mounting after the user
    // navigates to AI providers >`staleTime` after the Sidebar's first fetch)
    // would refetch through the fast `runDoctor` queryFn (which carries no
    // version data) and land *after* the freshness pass's `setQueryData`,
    // overwriting `installedVersion`/`latestVersion`/`updateAvailable` and
    // making the "Update available" badge appear briefly and then vanish.
    refetchOnMount: false,
  });
}

// Warm the report when Settings opens. `fetchQuery` returns the cached payload
// when it's fresh and not invalidated (so a StrictMode double-fire / fast
// re-entry within the staleTime window is a no-op), and dedupes against any
// in-flight fetch by query key. Crucially — unlike `ensureQueryData`, which
// returns cached data even when the entry has been invalidated — `fetchQuery`
// honors `isInvalidated`, so after `rerunDoctorReport` invalidates the key it
// actually awaits the active observer's refetch instead of resolving with the
// pre-rerun payload.
export function prefetchDoctorReport(qc: QueryClient) {
  return qc.fetchQuery({
    queryKey: DOCTOR_REPORT_QUERY_KEY,
    queryFn: runDoctor,
    staleTime: DOCTOR_REPORT_STALE_TIME,
  });
}

// Bust the shared key after a fix so Doctor and Providers stay consistent.
export function invalidateDoctorReport(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: DOCTOR_REPORT_QUERY_KEY });
}

// Run the freshness pass off the synchronous status-read path and fill in
// version/update badges progressively.
//
// The fast `runDoctor` (freshness off, offline) paints first; this then runs
// the slower `runDoctorFresh` (binary version probes + registry lookups, cheap
// after the crate's 1-hour disk cache warms) and seeds the *superset* result
// straight into the shared cache via `setQueryData`. We seed rather than
// `invalidateDoctorReport` because invalidation would refetch through the fast,
// freshness-off `runDoctor` queryFn and immediately drop the version fields we
// just gathered. Seeding keeps first paint instant while badges fill in.
//
// `fetchQuery` (not `ensureQueryData`) with a real staleTime on the freshness
// sibling key. React StrictMode in dev double-fires `SettingsView`'s mount
// effect, and any other re-entry within the staleTime window similarly hits
// this twice; with `fetchQuery({ staleTime: 30s })` the second call returns
// the cached freshness payload (or shares the in-flight promise) instead of
// kicking a second `runDoctorFresh` whose transient registry/probe diffs could
// blank the `updateAvailable` badge. Crucially — unlike `ensureQueryData`,
// which returns cached data even after invalidation — `fetchQuery` honors
// `isInvalidated`, so `rerunDoctorReport`'s explicit freshness invalidation
// actually triggers a fresh probe instead of resolving with the stale payload.
//
// Best-effort: a freshness failure leaves the fast report in place. We await
// the fast warm-up first so a late `runDoctor` resolution can't clobber the
// freshness data we write — this only works because `prefetchDoctorReport`
// now uses `fetchQuery` too, which actually awaits the active observer's
// in-flight refetch after invalidation.
export async function refreshDoctorReportFreshness(qc: QueryClient) {
  try {
    await prefetchDoctorReport(qc);
    const fresh = await qc.fetchQuery({
      queryKey: DOCTOR_REPORT_FRESHNESS_QUERY_KEY,
      queryFn: runDoctorFresh,
      staleTime: DOCTOR_REPORT_STALE_TIME,
      retry: false,
    });
    qc.setQueryData(DOCTOR_REPORT_QUERY_KEY, fresh);
  } catch {
    // Leave the fast offline report in place; badges simply stay unpopulated.
  }
}

// True while the background freshness pass is in flight. Consumers OR this
// into their existing "checking" state so per-card spinners and rerun buttons
// stay up through the slow leg, not just the fast `runDoctor` queryFn.
export function useDoctorReportFreshnessFetching(): boolean {
  return useIsFetching({ queryKey: DOCTOR_REPORT_FRESHNESS_QUERY_KEY }) > 0;
}

// Manual rerun / post-fix refresh. Bust the shared key (forcing a real
// re-probe past `staleTime`) and then re-run the background freshness pass so
// version/install-source/update badges repopulate. Without the freshness
// re-kick, invalidation alone refetches through the fast, freshness-off
// `runDoctor` queryFn and the badges blank out until Settings is reopened.
export function rerunDoctorReport(qc: QueryClient) {
  invalidateDoctorReport(qc);
  // Also bust the freshness sibling key. `refreshDoctorReportFreshness` uses
  // `fetchQuery({ staleTime: 30s })`, which respects `isInvalidated`, so this
  // explicit invalidation is what forces a real `runDoctorFresh` re-probe on
  // manual rerun within the staleTime window.
  qc.invalidateQueries({ queryKey: DOCTOR_REPORT_FRESHNESS_QUERY_KEY });
  return refreshDoctorReportFreshness(qc);
}
