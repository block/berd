/**
 * Deterministic layout for the avatar collection canvas.
 *
 * `buildCollectionLayout` — collection pages. Positions come from the 18
 * avatar placements traced out of the Figma reference frame ("Avatars —
 * Gloopies", node 916-18033, 1440x1024), normalized and rescaled to the
 * window. The reference is an organic, well-spaced field (no shared row
 * baselines, no size ramps toward the corners), which reads intentional
 * in a way generated lattices never quite did. The trace is rebuilt into
 * antipodal pairs (exact 180° rotational symmetry — see `symmetrizePairs`)
 * so the field is balanced by construction; pairs are farthest-point
 * ordered with a diagonal-lean discount so every prefix stays evenly
 * spread across all four quadrants. Overflow items beyond 18 are placed
 * by best-candidate sampling (maximize distance to everything placed).
 *
 * The layout is *toroidal*: the renderer tiles it modulo the cell size for
 * the infinite pan canvas (see `applyPan` in AvatarCollectionOverlay), so
 * every distance here is the minimal-image torus distance and positions
 * wrap instead of clamping to tile edges. A bounded layout would repeat
 * its "walls" as empty seam corridors at every tile boundary; a toroidal
 * one has no walls, so the field flows seamlessly across the wrap and the
 * edge bleed of the Figma frame falls out for free (a box near an edge is
 * simply cut by it, its remainder appearing on the opposite side of the
 * neighboring tile copy).
 *
 * `edgePadding` is therefore a no-op kept for signature compatibility:
 * there is no meaningful edge inset on a torus. The wrap *is* the edge
 * bleed.
 *
 * Positions derive from item ids + counts only, so layouts are stable across
 * renders and reopenings without persisting anything.
 *
 * (The collections level renders as a static row in a box, not a scatter
 * field, so it needs no layout builder.)
 */

export interface ScatterItemLayout {
  id: string;
  /** Center of the item within the tile, px (always in [0, tileWidth) × [0, tileHeight)). */
  x: number;
  y: number;
  /** Rendered square size, px. */
  size: number;
  /** Staggered entrance delay. */
  popDelayMs: number;
}

export interface CollectionLayoutOptions {
  /**
   * Target uniform item size, px. The Figma reference runs 153-220px on a
   * 1440-wide frame (~11-15% of width); hosts should pass a size in that
   * proportion. Shrinks automatically if the field gets tight.
   */
  itemSize?: number;
  /**
   * No-op, kept for signature compatibility. The layout is toroidal (it
   * wraps modulo the tile size, matching the renderer's infinite tiling),
   * so there is no edge to pad against — items near a tile edge bleed
   * across it into the adjacent tile copy by construction.
   */
  edgePadding?: number;
  /** Minimum clear gap between neighboring item boxes, px. */
  minGap?: number;
  popStaggerMs?: number;
  popDelayCapMs?: number;
  /** Keep-out rect centered in the tile (the wordmark + controls). */
  centerExclusion?: { width: number; height: number };
}

/** FNV-1a — stable across sessions, good dispersion for short ids. */
export function scatterHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Derive a stable 0..1 float from a hash and a salt. */
function unit(hash: number, salt: number): number {
  const mixed = Math.imul(hash ^ Math.imul(salt, 0x9e3779b9), 2654435761) >>> 0;
  return mixed / 4294967296;
}

/** Signed minimal-image delta `a - b` on a circle of circumference `length`. */
export function torusDelta(a: number, b: number, length: number): number {
  const d = a - b;
  return d - length * Math.round(d / length);
}

/** Minimal-image distance between two points on a `width` × `height` torus. */
export function torusDist(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  height: number,
): number {
  return Math.hypot(torusDelta(ax, bx, width), torusDelta(ay, by, height));
}

/** Wrap a coordinate into [0, length). */
function wrapCoord(value: number, length: number): number {
  return ((value % length) + length) % length;
}

/**
 * Avatar center positions, normalized to 0..1 on both axes. Authored along
 * the diagonal flows of the Figma reference frame (node 916-18033): the
 * field reads as three parallel top-left → bottom-right bands — one through
 * the center (crossing the wordmark; overlap is intentional, avatars sit on
 * the text like the reference), one upper-right, one lower-left — plus
 * corner accents and a mid-fill pair so the gaps between bands never read
 * as empty lanes. Each point carries a small alternating perpendicular
 * nudge so the lines feel hand-placed rather than ruled.
 *
 * The list is authored as antipodal pairs about the center (and then
 * re-symmetrized below), so balance is exact by construction. On the torus
 * an antipodal pair `(p, (1,1) - p)` stays exactly antipodal under wrap,
 * so the balance machinery survives the toroidal rendering verbatim.
 *
 * The outermost center-diagonal pair sits at 0.04/0.96 (not 0.01/0.99 as
 * traced): through the wrap those two points would be only ~0.02 of the
 * tile apart, and the relaxation pass would have to spend its budget
 * fighting the template instead of filling seam voids.
 */
const FIGMA_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  // Center diagonal, outward from the wordmark.
  [0.325, 0.43],
  [0.675, 0.57],
  [0.16, 0.3],
  [0.84, 0.7],
  [0.04, 0.21],
  [0.96, 0.79],
  // Upper-right diagonal and its lower-left image.
  [0.37, 0.04],
  [0.63, 0.96],
  [0.56, 0.125],
  [0.44, 0.875],
  [0.75, 0.245],
  [0.25, 0.755],
  [0.945, 0.36],
  [0.055, 0.64],
  // Corner accents: top-right and bottom-left corners the bands miss.
  [0.875, 0.06],
  [0.125, 0.94],
  // Mid-fill between the center and lower band.
  [0.36, 0.665],
  [0.64, 0.335],
];

/**
 * Rebuild the traced template as antipodal pairs — exact 180° rotational
 * symmetry about the frame center — while moving each traced point as
 * little as possible.
 *
 * Why: the raw trace is organic but unbalanced (its center of mass drifts
 * up to ~8% of the window at small counts, and quadrant counts skew 3/5/6/4
 * at 18 items — it reads bottom-heavy). Greedily match each point with the
 * point closest to its antipode, then split the difference: both members
 * move half the residual so the pair becomes exactly point-symmetric.
 * Rotational (not mirror) symmetry keeps the field feeling organic — no
 * kaleidoscope axis — while the balance becomes exact by construction.
 *
 * Pairs are then ordered farthest-point-first (by how far a pair sits from
 * everything already chosen) and emitted pair-adjacent, so *every even
 * prefix* of the template has its center of mass exactly on the window
 * center: a 6-avatar collection is as balanced as an 18-avatar one. Odd
 * counts are off by at most one item's pull.
 */
function symmetrizePairs(
  points: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number]> {
  const remaining = points.map(([x, y]) => [x, y] as [number, number]);
  const pairs: Array<
    readonly [readonly [number, number], readonly [number, number]]
  > = [];
  while (remaining.length >= 2) {
    // Take the point farthest from the center first — its antipode is the
    // most constrained match — then grab whoever sits closest to that
    // antipode.
    let anchorIndex = 0;
    let anchorDistance = -1;
    remaining.forEach(([x, y], index) => {
      const d = Math.hypot(x - 0.5, y - 0.5);
      if (d > anchorDistance) {
        anchorDistance = d;
        anchorIndex = index;
      }
    });
    const [anchor] = remaining.splice(anchorIndex, 1);
    const targetX = 1 - anchor[0];
    const targetY = 1 - anchor[1];
    let mateIndex = 0;
    let mateDistance = Number.POSITIVE_INFINITY;
    remaining.forEach(([x, y], index) => {
      const d = Math.hypot(x - targetX, y - targetY);
      if (d < mateDistance) {
        mateDistance = d;
        mateIndex = index;
      }
    });
    const [mate] = remaining.splice(mateIndex, 1);
    // Split the difference: move each endpoint half the residual so the
    // pair is exactly antipodal.
    const halfX = (anchor[0] + 1 - mate[0]) / 2;
    const halfY = (anchor[1] + 1 - mate[1]) / 2;
    pairs.push([
      [halfX, halfY],
      [1 - halfX, 1 - halfY],
    ]);
  }

  // Farthest-point ordering over whole pairs: repeatedly take the pair
  // whose nearest member-to-chosen distance is largest, so small
  // collections use well-separated pairs. The first pair is the one
  // farthest from the center (strongest corner anchors).
  //
  // An antipodal pair spans one diagonal (its members sit in opposite
  // quadrants), so distance alone can pick several same-diagonal pairs in
  // a row — an 8-item collection then reads as a band from corner to
  // corner. Track how many chosen pairs lean each way and, among pairs
  // whose spread score is close to the best, prefer the one that evens
  // the diagonals out.
  const orderedPairs: typeof pairs = [];
  const pool = [...pairs];
  let diagonalLean = 0; // >0: more LT-RB pairs chosen; <0: more RT-LB.
  const pairDiagonal = (
    pair: readonly [readonly [number, number], readonly [number, number]],
  ) => {
    const [x, y] = pair[0];
    // Sign of (x-0.5)(y-0.5) says which diagonal's quadrants the pair
    // occupies. No neutral band: an antipodal pair always fills two
    // opposite quadrants, and letting near-axis pairs skip the count is
    // exactly how three same-diagonal pairs snuck into an 8-item prefix.
    return (x - 0.5) * (y - 0.5) > 0 ? 1 : -1;
  };
  while (pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    pool.forEach((pair, index) => {
      let score: number;
      if (orderedPairs.length === 0) {
        score = Math.hypot(pair[0][0] - 0.5, pair[0][1] - 0.5);
      } else {
        score = Number.POSITIVE_INFINITY;
        for (const [x, y] of pair) {
          for (const chosen of orderedPairs) {
            for (const [ox, oy] of chosen) {
              score = Math.min(score, Math.hypot(x - ox, y - oy));
            }
          }
        }
      }
      // Discount pairs that deepen the diagonal lean; a counter or neutral
      // pair wins unless its spread is dramatically worse.
      if (pairDiagonal(pair) === Math.sign(diagonalLean)) {
        score *= 0.6;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    diagonalLean += pairDiagonal(pool[bestIndex]);
    orderedPairs.push(...pool.splice(bestIndex, 1));
  }
  return orderedPairs.flat();
}

const ORDERED_TEMPLATE = symmetrizePairs(FIGMA_TEMPLATE);

/** Best-candidate samples per overflow item (beyond the 18 template slots). */
const OVERFLOW_CANDIDATES = 24;
/** Anisotropic relaxation iterations. */
const RELAX_ITERATIONS = 60;
/** Soft fill radius as a multiple of the mean spacing `sqrt(W·H / count)`. */
const FILL_RADIUS_FACTOR = 1.4;
/** Soft fill force scale. */
const FILL_STRENGTH = 0.35;
/**
 * Perpendicular damping for the soft fill force. The force component along
 * the tile diagonal (the Figma flow direction) is applied in full so points
 * slide along their band into seam voids; the perpendicular component is
 * damped so the bands spread without dissolving into an even lattice.
 * Lower = crisper bands, higher = more uniform coverage.
 */
const PERPENDICULAR_DAMPING = 0.4;
/** Hard-separation sweeps after relaxation. */
const SEPARATION_SWEEPS = 40;

export function buildCollectionLayout(
  ids: readonly string[],
  tileWidth: number,
  tileHeight: number,
  {
    itemSize = 160,
    minGap = 24,
    popStaggerMs = 30,
    popDelayCapMs = 480,
    centerExclusion,
  }: CollectionLayoutOptions = {},
): ScatterItemLayout[] {
  if (ids.length === 0) {
    return [];
  }

  const count = ids.length;
  const half = itemSize / 2;
  const width = tileWidth;
  const height = tileHeight;
  const centerX = width / 2;
  const centerY = height / 2;

  const wrapX = (x: number) => wrapCoord(x, width);
  const wrapY = (y: number) => wrapCoord(y, height);
  const dist = (ax: number, ay: number, bx: number, by: number) =>
    torusDist(ax, ay, bx, by, width, height);

  // The center keep-out stays a per-tile rect (the renderer draws the
  // wordmark once per tile at the tile center), so collision here is plain
  // per-tile geometry, not toroidal.
  const collidesWithExclusion = (x: number, y: number) =>
    centerExclusion
      ? Math.abs(x - centerX) < centerExclusion.width / 2 + half &&
        Math.abs(y - centerY) < centerExclusion.height / 2 + half
      : false;

  /** Push a colliding point out along the axis needing the smallest move. */
  const resolveExclusion = (x: number, y: number): [number, number] => {
    if (!centerExclusion || !collidesWithExclusion(x, y)) {
      return [x, y];
    }
    const reachX = centerExclusion.width / 2 + half;
    const reachY = centerExclusion.height / 2 + half;
    const depthX = reachX - Math.abs(x - centerX);
    const depthY = reachY - Math.abs(y - centerY);
    if (depthX <= depthY) {
      const direction = x >= centerX ? 1 : -1;
      return [wrapX(centerX + direction * reachX), y];
    }
    const direction = y >= centerY ? 1 : -1;
    return [x, wrapY(centerY + direction * reachY)];
  };

  // Template slots, mapped straight onto the torus — no edge inset, no
  // clamps. The wrap is the edge bleed.
  const slots: Array<[number, number]> = ORDERED_TEMPLATE.slice(
    0,
    Math.min(count, ORDERED_TEMPLATE.length),
  ).map(([nx, ny]) => resolveExclusion(wrapX(nx * width), wrapY(ny * height)));

  // Overflow beyond the template: best-candidate sampling — try a batch of
  // deterministic points, keep the one farthest (toroidally) from
  // everything placed.
  for (let index = slots.length; index < count; index += 1) {
    const hash = scatterHash(ids[index]);
    let best: [number, number] | null = null;
    let bestScore = -1;
    for (let candidate = 0; candidate < OVERFLOW_CANDIDATES; candidate += 1) {
      const x = unit(hash, 20 + candidate * 2) * width;
      const y = unit(hash, 21 + candidate * 2) * height;
      if (collidesWithExclusion(x, y)) {
        continue;
      }
      let minDistance = Number.POSITIVE_INFINITY;
      for (const [sx, sy] of slots) {
        minDistance = Math.min(minDistance, dist(x, y, sx, sy));
      }
      if (minDistance > bestScore) {
        bestScore = minDistance;
        best = [x, y];
      }
    }
    slots.push(
      best ?? resolveExclusion(unit(hash, 2) * width, unit(hash, 3) * height),
    );
  }

  // Anisotropic toroidal relaxation. Two regimes per pair, both measured
  // with the minimal-image delta so the field can "see" across the seam:
  //
  // - closer than `target` (box + gap): hard isotropic push apart, half
  //   the deficit each — the non-negotiable separation constraint;
  // - closer than the fill radius `R`: a soft decaying spread force,
  //   decomposed along the tile diagonal (the Figma flow direction) with
  //   the perpendicular component damped. Points slide *along* their
  //   diagonal band into the voids the bounded layout used to leave at
  //   seams and cell corners, instead of exploding radially into a
  //   featureless lattice.
  //
  // Every move wraps and re-respects the center exclusion.
  //
  // The separation target is capped at the mean spacing: the hex packing
  // limit is ~1.07x spacing, so beyond ~1x the requested `itemSize +
  // minGap` is geometrically unattainable and uncapped push-apart sweeps
  // jam into a non-uniform tangle instead of converging. Capping keeps the
  // field uniform; the shrink fallback below reduces the rendered size to
  // whatever separation was actually achieved.
  const spacing = Math.sqrt((width * height) / count);
  const target = Math.min(itemSize + minGap, spacing);
  const fillRadius = FILL_RADIUS_FACTOR * spacing;
  const diagonal = Math.hypot(width, height);
  const alongX = width / diagonal;
  const alongY = height / diagonal;
  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
    const decay = 1 - iteration / RELAX_ITERATIONS;
    let movement = 0;
    for (let a = 0; a < slots.length; a += 1) {
      for (let b = a + 1; b < slots.length; b += 1) {
        const [ax, ay] = slots[a];
        const [bx, by] = slots[b];
        const dx = torusDelta(bx, ax, width);
        const dy = torusDelta(by, ay, height);
        const distance = Math.hypot(dx, dy);
        if (distance >= fillRadius) {
          continue;
        }
        const ux = distance > 0 ? dx / distance : 1;
        const uy = distance > 0 ? dy / distance : 0;
        let moveX: number;
        let moveY: number;
        if (distance < target) {
          const push = (target - distance) / 2;
          moveX = ux * push;
          moveY = uy * push;
        } else {
          const force = ((fillRadius - distance) / 2) * FILL_STRENGTH * decay;
          const forceX = ux * force;
          const forceY = uy * force;
          const along = forceX * alongX + forceY * alongY;
          const perpendicular = -forceX * alongY + forceY * alongX;
          const damped = perpendicular * PERPENDICULAR_DAMPING;
          moveX = along * alongX - damped * alongY;
          moveY = along * alongY + damped * alongX;
        }
        slots[a] = resolveExclusion(wrapX(ax - moveX), wrapY(ay - moveY));
        slots[b] = resolveExclusion(wrapX(bx + moveX), wrapY(by + moveY));
        movement += 2 * Math.hypot(moveX, moveY);
      }
    }
    if (movement < 0.5) {
      break;
    }
  }

  // Hard-separation guarantee: sweep pairwise push-apart (toroidal deltas)
  // until no pair sits closer than the target, so the shrink fallback below
  // only fires when the tile genuinely cannot hold the requested size.
  for (let sweep = 0; sweep < SEPARATION_SWEEPS; sweep += 1) {
    let violated = false;
    for (let a = 0; a < slots.length; a += 1) {
      for (let b = a + 1; b < slots.length; b += 1) {
        const [ax, ay] = slots[a];
        const [bx, by] = slots[b];
        const dx = torusDelta(bx, ax, width);
        const dy = torusDelta(by, ay, height);
        const distance = Math.hypot(dx, dy);
        if (distance >= target) {
          continue;
        }
        violated = true;
        const push = (target - distance) / 2;
        const ux = distance > 0 ? dx / distance : 1;
        const uy = distance > 0 ? dy / distance : 0;
        slots[a] = resolveExclusion(
          wrapX(ax - ux * push),
          wrapY(ay - uy * push),
        );
        slots[b] = resolveExclusion(
          wrapX(bx + ux * push),
          wrapY(by + uy * push),
        );
      }
    }
    if (!violated) {
      break;
    }
  }

  // If anything is still tight (crowded small windows), shrink the uniform
  // size so boxes never overlap and the highlighted avatar keeps clear air.
  let minPairDistance = Number.POSITIVE_INFINITY;
  for (let a = 0; a < slots.length; a += 1) {
    for (let b = a + 1; b < slots.length; b += 1) {
      minPairDistance = Math.min(
        minPairDistance,
        dist(slots[a][0], slots[a][1], slots[b][0], slots[b][1]),
      );
    }
  }
  const size =
    slots.length > 1
      ? Math.max(48, Math.min(itemSize, Math.floor(minPairDistance - minGap)))
      : itemSize;

  return ids.map((id, index) => {
    const [x, y] = slots[index];
    return {
      id,
      x,
      y,
      size,
      popDelayMs: Math.min(index * popStaggerMs, popDelayCapMs),
    };
  });
}
