// Vendored typed telemetry event modules. Originally generated from
// squareup/message-schemas; the generator is not part of this repo, so these
// are ordinary source now — edit by hand and keep event/param names aligned
// with the schema repo.

/**
 * Neutral telemetry event envelope returned by the event factories.
 *
 * Mirrors the minimal { name, parameters } shape the telemetry client hands to
 * its transport, so this repo carries no dependency on
 * `@squareup/message-schemas-web`.
 */
export interface Event {
  /** snake_case Unified Eventing event name (e.g. "berd_app_lifecycle_launched"). */
  name: string;
  /** Event parameters keyed by their snake_case schema names. */
  parameters: Record<string, unknown>;
}
