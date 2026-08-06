import { describe, expect, it } from "vitest";
import {
  buildCollectionLayout,
  scatterHash,
  torusDelta,
  torusDist,
} from "@/features/agents/lib/avatarScatter";

const IDS = Array.from({ length: 21 }, (_, index) => `gloopy-${index + 1}`);

const OPTIONS = {
  itemSize: 172,
  minGap: 24,
  centerExclusion: { width: 820, height: 240 },
} as const;

/** Options as the overlay passes them (no center keep-out). */
const OVERLAY_OPTIONS = {
  itemSize: 172,
  minGap: 24,
} as const;

function idList(count: number): string[] {
  return IDS.slice(0, count).concat(
    Array.from(
      { length: Math.max(0, count - IDS.length) },
      (_, index) => `extra-${index}`,
    ),
  );
}

describe("scatterHash", () => {
  it("is deterministic", () => {
    expect(scatterHash("gloopy-1")).toBe(scatterHash("gloopy-1"));
  });

  it("disperses similar ids", () => {
    expect(scatterHash("gloopy-1")).not.toBe(scatterHash("gloopy-2"));
  });
});

describe("torusDelta / torusDist", () => {
  it("returns the signed minimal image", () => {
    expect(torusDelta(10, 990, 1000)).toBe(20);
    expect(torusDelta(990, 10, 1000)).toBe(-20);
    expect(torusDelta(400, 100, 1000)).toBe(300);
  });

  it("measures across the seam", () => {
    expect(torusDist(5, 5, 995, 5, 1000, 500)).toBe(10);
    expect(torusDist(5, 495, 5, 5, 1000, 500)).toBe(10);
  });
});

describe("buildCollectionLayout", () => {
  it("returns an empty layout for no ids", () => {
    expect(buildCollectionLayout([], 1440, 1024)).toEqual([]);
  });

  it("is deterministic for the same ids and tile size", () => {
    const first = buildCollectionLayout(IDS, 1440, 1024, OPTIONS);
    const second = buildCollectionLayout(IDS, 1440, 1024, OPTIONS);
    expect(second).toEqual(first);
  });

  it("uses a uniform size", () => {
    const layout = buildCollectionLayout(IDS, 1440, 1024, OPTIONS);
    expect(new Set(layout.map((item) => item.size)).size).toBe(1);
  });

  it("keeps every center inside the fundamental tile (renderer wrap contract)", () => {
    for (const options of [OPTIONS, OVERLAY_OPTIONS]) {
      for (const count of [4, 12, 18, 30]) {
        const layout = buildCollectionLayout(
          idList(count),
          1440,
          1024,
          options,
        );
        for (const item of layout) {
          expect(item.x).toBeGreaterThanOrEqual(0);
          expect(item.x).toBeLessThan(1440);
          expect(item.y).toBeGreaterThanOrEqual(0);
          expect(item.y).toBeLessThan(1024);
        }
      }
    }
  });

  it("never overlaps two items, measured toroidally (the tiled canvas has no seam-adjacent collisions)", () => {
    for (const options of [OPTIONS, OVERLAY_OPTIONS]) {
      for (const count of [4, 8, 12, 18, 21, 30]) {
        const layout = buildCollectionLayout(
          idList(count),
          1440,
          1024,
          options,
        );
        for (let a = 0; a < layout.length; a += 1) {
          for (let b = a + 1; b < layout.length; b += 1) {
            const itemA = layout[a];
            const itemB = layout[b];
            const distance = torusDist(
              itemA.x,
              itemA.y,
              itemB.x,
              itemB.y,
              1440,
              1024,
            );
            expect(distance).toBeGreaterThanOrEqual(
              (itemA.size + itemB.size) / 2,
            );
          }
        }
      }
    }
  });

  it("keeps the minimum gap when the requested size fits, measured toroidally", () => {
    const layout = buildCollectionLayout(
      IDS.slice(0, 18),
      1440,
      1024,
      OVERLAY_OPTIONS,
    );
    for (let a = 0; a < layout.length; a += 1) {
      for (let b = a + 1; b < layout.length; b += 1) {
        const distance = torusDist(
          layout[a].x,
          layout[a].y,
          layout[b].x,
          layout[b].y,
          1440,
          1024,
        );
        expect(distance).toBeGreaterThanOrEqual(
          layout[a].size + OVERLAY_OPTIONS.minGap - 1e-6,
        );
      }
    }
  });

  it("keeps items out of the center exclusion rect", () => {
    for (const options of [OPTIONS]) {
      const layout = buildCollectionLayout(IDS, 1440, 1024, options);
      for (const item of layout) {
        const half = OPTIONS.itemSize / 2;
        const overlapsX =
          Math.abs(item.x - 720) < OPTIONS.centerExclusion.width / 2 + half;
        const overlapsY =
          Math.abs(item.y - 512) < OPTIONS.centerExclusion.height / 2 + half;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
  });

  it("fills all four quadrants of the tile", () => {
    const layout = buildCollectionLayout(IDS, 1440, 1024, OVERLAY_OPTIONS);
    const quadrants = new Set(
      layout.map(
        (item) => `${item.x < 720 ? "L" : "R"}${item.y < 512 ? "T" : "B"}`,
      ),
    );
    expect(quadrants).toEqual(new Set(["LT", "RT", "LB", "RB"]));
  });

  it("balances every even-count prefix around the window center", () => {
    // The template is built from antipodal pairs emitted pair-adjacent —
    // and on the torus a pair (p, (W,H)-p) stays exactly antipodal under
    // wrap — so any even prefix has its center of mass near the window
    // center (relaxation is symmetric up to sequential-update residue).
    // Guard the visual promise loosely: within 4% of the window per axis,
    // measured toroidally so a pair straddling the seam still counts as
    // balanced.
    for (const count of [4, 6, 8, 10, 12, 14, 16, 18]) {
      const layout = buildCollectionLayout(
        IDS.slice(0, count),
        1440,
        1024,
        OVERLAY_OPTIONS,
      );
      const comX =
        layout.reduce((sum, item) => sum + torusDelta(item.x, 720, 1440), 0) /
        count;
      const comY =
        layout.reduce((sum, item) => sum + torusDelta(item.y, 512, 1024), 0) /
        count;
      expect(Math.abs(comX)).toBeLessThanOrEqual(1440 * 0.04);
      expect(Math.abs(comY)).toBeLessThanOrEqual(1024 * 0.04);
    }
  });

  it("balances quadrant counts (no diagonal banding)", () => {
    // Antipodal pairs guarantee opposite quadrants; the diagonal-lean
    // discount in the pair ordering keeps runs of same-diagonal pairs from
    // forming a corner-to-corner band. No quadrant may dominate: at most a
    // difference of 2 between the fullest and emptiest quadrant.
    for (const count of [8, 12, 18]) {
      const layout = buildCollectionLayout(
        IDS.slice(0, count),
        1440,
        1024,
        OVERLAY_OPTIONS,
      );
      const counts = { LT: 0, RT: 0, LB: 0, RB: 0 };
      for (const item of layout) {
        counts[
          `${item.x < 720 ? "L" : "R"}${item.y < 512 ? "T" : "B"}` as keyof typeof counts
        ] += 1;
      }
      const values = Object.values(counts);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2);
    }
  });

  it("spreads small sets instead of clustering them", () => {
    // Prefixes of the template are farthest-point ordered, so even 5 items
    // should land in at least 3 distinct quadrants.
    const layout = buildCollectionLayout(
      IDS.slice(0, 5),
      1440,
      1024,
      OVERLAY_OPTIONS,
    );
    const quadrants = new Set(
      layout.map(
        (item) => `${item.x < 720 ? "L" : "R"}${item.y < 512 ? "T" : "B"}`,
      ),
    );
    expect(quadrants.size).toBeGreaterThanOrEqual(3);
  });

  it("keeps the full requested size at reference density", () => {
    // 18 items on the Figma frame proportions must not trigger the shrink
    // fallback — if this fails the layout has drifted denser than the design.
    const layout = buildCollectionLayout(
      IDS.slice(0, 18),
      1440,
      1024,
      OVERLAY_OPTIONS,
    );
    expect(layout[0].size).toBeGreaterThanOrEqual(OPTIONS.itemSize - 2);
  });

  it("handles more items than the template has slots", () => {
    const many = Array.from({ length: 30 }, (_, index) => `extra-${index}`);
    const layout = buildCollectionLayout(many, 1840, 1050, OPTIONS);
    expect(layout).toHaveLength(30);
    // All centers inside the fundamental tile.
    for (const item of layout) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThan(1840);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThan(1050);
    }
  });

  it("leaves no seam corridors or corner voids in the tiled canvas (max empty circle)", () => {
    // Regression for the pan-gap bug: the renderer tiles the layout
    // toroidally, so grid-sample the (equivalent of the) 3x3 tiling and
    // assert the largest empty circle — the biggest void a panning user
    // can center on screen — stays below 0.8x the mean spacing. The old
    // bounded layout failed this wildly: its edge padding and clamped
    // relaxation repeated as empty corridors along every seam and a void
    // 2x the avatar size at every cell corner.
    const tileSizes: ReadonlyArray<readonly [number, number]> = [
      [1784, 1254],
      [1200, 800],
    ];
    const GRID = 96;
    for (const [width, height] of tileSizes) {
      for (const count of [6, 12, 18, 24, 40]) {
        const itemSize = Math.round(Math.min(230, Math.max(140, width * 0.15)));
        const layout = buildCollectionLayout(idList(count), width, height, {
          itemSize,
          minGap: 24,
        });
        const spacing = Math.sqrt((width * height) / count);
        let maxEmptyRadius = 0;
        for (let gy = 0; gy < GRID; gy += 1) {
          for (let gx = 0; gx < GRID; gx += 1) {
            const x = ((gx + 0.5) / GRID) * width;
            const y = ((gy + 0.5) / GRID) * height;
            let nearest = Number.POSITIVE_INFINITY;
            for (const item of layout) {
              nearest = Math.min(
                nearest,
                torusDist(x, y, item.x, item.y, width, height),
              );
            }
            maxEmptyRadius = Math.max(maxEmptyRadius, nearest);
          }
        }
        expect(
          maxEmptyRadius,
          `count=${count} tile=${width}x${height} spacing=${spacing.toFixed(1)}`,
        ).toBeLessThanOrEqual(0.8 * spacing);
      }
    }
  });

  it("stays fast enough for render-time use", () => {
    const many = idList(40);
    // Warm up so JIT compilation is not billed to the first sample.
    for (let warmup = 0; warmup < 5; warmup += 1) {
      buildCollectionLayout(many, 1784, 1254, OVERLAY_OPTIONS);
    }

    // Median of several batches, not a single batch: this suite runs in
    // parallel with others, so any one batch can absorb an unrelated
    // scheduler stall. A median cannot be moved by a single outlier.
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const start = performance.now();
      for (let run = 0; run < 20; run += 1) {
        buildCollectionLayout(many, 1784, 1254, OVERLAY_OPTIONS);
      }
      samples.push((performance.now() - start) / 20);
    }
    samples.sort((first, second) => first - second);
    const medianPerCall = samples[Math.floor(samples.length / 2)];

    // Deliberately loose. This guards against an algorithmic regression
    // (an added O(n²) pass, a runaway iteration count), not against a few
    // hundred microseconds of drift. Measured ~3ms per call on a dev
    // machine, so this leaves roughly 8x headroom; tightening it to "just
    // above observed" is what made this test flake on loaded CI runners.
    expect(medianPerCall).toBeLessThan(25);
  });

  it("staggers pop delays with a cap", () => {
    const layout = buildCollectionLayout(IDS, 1440, 1024, {
      ...OPTIONS,
      popStaggerMs: 30,
      popDelayCapMs: 480,
    });
    expect(layout[0].popDelayMs).toBe(0);
    expect(layout[1].popDelayMs).toBeGreaterThan(0);
    for (const item of layout) {
      expect(item.popDelayMs).toBeLessThanOrEqual(480);
    }
  });
});
