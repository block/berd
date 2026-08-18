/**
 * Distribution fan-out sink — the seam a distro overlay replaces.
 *
 * A distribution (e.g. an internal build with its own analytics pipeline) can
 * swap this one file for a real implementation and receive every event the
 * telemetry client emits, without forking `./client`. The client calls the
 * sink from `emit` — after the build/environment gate, the consent gate, and
 * the startup buffer — so a replacement fires exactly for the events that
 * actually reach the OTel logger and inherits every gating decision, consent
 * included, for free. Events the gates suppress or the buffer discards never
 * arrive here.
 *
 * The stock implementation is a deliberate no-op with **no imports**: no
 * transport, no `invoke`, no side effects — dead weight in every stock build,
 * which is what makes replacing the file safe. Crash-safety lives on the
 * client's side of the seam (the call is guarded there, in code the overlay
 * does not replace), so a throwing replacement cannot disturb emission — but a
 * replacement should still do its own work fire-and-forget and never block.
 */

/** One emitted event, as handed to the sink. */
export interface DistributionSinkEvent {
  /** snake_case event name (e.g. "berd_app_lifecycle_launched"). */
  name: string;
  /**
   * The event's params — the same values the OTel record carries as its
   * attributes, but *pre-truncation*: the OTel `attributeValueLengthLimit`
   * applies inside the `LoggerProvider`, not here.
   */
  attributes: Record<string, unknown>;
  /**
   * ISO-8601 timestamp of when the event originally fired — for an event that
   * sat in the startup buffer, that is the fire time, not the flush time, so
   * a sink preserves real timing.
   */
  firedAt: string;
}

/**
 * Receives one emitted (post-gate) event. Stock: a pure no-op.
 */
export function distributionSink(_event: DistributionSinkEvent): void {
  // Deliberately empty — see the module doc. A distro overlay replaces this
  // file to fan events out to its own pipeline.
}
