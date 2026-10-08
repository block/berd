// Panel connection lifecycle — the in-process replacement for the
// prototype's ConnectionSupervisor. goosed is spawned once per Berd
// process and lives (and dies) with the app, so the 3s/180s blind retry
// loop is gone. What remains is Berd's reconnect-on-demand pattern: the
// shared acpConnection clears its cached client when the socket closes,
// and the next connect() dials fresh. This class owns the panel-side
// choreography around that seam:
//
// - single-flight attach (StrictMode double-mounts, retry mashing)
// - watch `client.closed` and auto re-attach ONCE; a second consecutive
//   failure reports exhaustion (the manual retry affordance takes over —
//   claiming "reconnecting…" forever when goosed died with the app would
//   be a lie)
// - dispose() for unmount (late resolutions must not mutate anything)
//
// Ports are injected so the whole lifecycle is fake-testable.

export interface PanelClientLike {
  /** Resolves (or rejects) when the underlying connection closes. */
  closed: Promise<unknown>;
}

export interface PanelConnectionPorts {
  /** Production: acpConnection.getClient(). Must dial fresh after the
   *  previous connection closed (the shared module guarantees this). */
  connect(): Promise<PanelClientLike>;
}

export interface PanelConnectionEvents {
  /** Connected (or re-connected). Fires once per successful attach. */
  onAttached(): void;
  /** Connection lost; an automatic re-attach may follow. */
  onDetached(): void;
  /** An attach attempt failed. `exhausted` is true when no further
   *  automatic attempt will happen. */
  onFailed(error: string, exhausted: boolean): void;
}

export class PanelConnection {
  private attaching = false;
  private disposed = false;
  /** Orphans stale closed-watchers after re-attach/dispose. */
  private generation = 0;
  private everAttached = false;
  /** An attach bounced off the single-flight guard while the in-flight
   *  dial belonged to a DISPOSED generation (StrictMode: mount 1 dials,
   *  cleanup disposes, mount 2 revives and attaches into the guard). The
   *  stale dial's finally honors this by redialing for the live
   *  generation — without it the panel would sit unattached until a
   *  manual retry. */
  private reattachRequested = false;

  constructor(
    private readonly ports: PanelConnectionPorts,
    private readonly events: PanelConnectionEvents,
  ) {}

  /** Attach once (single-flight). `auto` marks automatic recovery
   *  attempts: their failure is exhaustion; a manual attach failing is
   *  not (the user can click again). */
  async attach(auto = false): Promise<boolean> {
    if (this.disposed) return false;
    if (this.attaching) {
      this.reattachRequested = true;
      return false;
    }
    this.attaching = true;
    const generation = ++this.generation;
    try {
      const client = await this.ports.connect();
      if (this.disposed || generation !== this.generation) return false;
      this.everAttached = true;
      this.events.onAttached();
      this.watchClosed(client, generation);
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.events.onFailed(String(error), auto);
        if (!auto && !this.everAttached) {
          // A first attach failure is equivalent to a dropped connection:
          // one bounded recovery dial follows, then exhaustion makes the
          // manual Retry affordance truthful and visible.
          queueMicrotask(() => void this.attach(true));
        }
      }
      return false;
    } finally {
      this.attaching = false;
      // Serve a bounced attach only when this dial's outcome was orphaned
      // (generation moved on) — a same-generation success already served
      // every caller via onAttached.
      const orphanedRequest =
        this.reattachRequested &&
        !this.disposed &&
        generation !== this.generation;
      this.reattachRequested = false;
      if (orphanedRequest) void this.attach(auto);
    }
  }

  private watchClosed(client: PanelClientLike, generation: number): void {
    const settle = () => {
      if (this.disposed || generation !== this.generation) return;
      this.events.onDetached();
      // One automatic recovery attempt: goosed restarts are Berd-driven
      // (a fresh spawn under the same process), so a single fresh dial
      // either finds it or nothing is coming back.
      void this.attach(true);
    };
    client.closed.then(settle, settle);
  }

  /** StrictMode second mount undoes the first cleanup's dispose. */
  revive(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }
}
