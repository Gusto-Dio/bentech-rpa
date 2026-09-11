/**
 * The geometry behind "is this screenshot safe to commit?".
 *
 * Extracted from `check-masked-evidence.ts` so it can be unit-tested. It is the
 * load-bearing safety property of the whole evidence pipeline: these images go
 * into git history, where a masking miss is permanent, so the containment rule
 * deserves tests rather than a careful reading.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Half a pixel, for sub-pixel layout rounding. Not a tolerance for real gaps. */
const EPSILON = 0.5;

/**
 * Is this box entirely inside the union of the masks?
 *
 * ── ENTIRELY, NOT PARTIALLY ─────────────────────────────────────────────────
 * Deliberately not "does it overlap a mask". A control half-covered is a
 * control whose value may be half-readable, and a partially visible FEIN is
 * still a FEIN.
 *
 * The fast path is containment in a single mask, which is the common case. The
 * grid fallback handles a control covered by SEVERAL adjacent masks - which
 * happens whenever a table cell and the element inside it both resolve - without
 * implementing a polygon union.
 */
export function isCovered(box: Box, masks: readonly Box[]): boolean {
  if (box.width === 0 || box.height === 0) return true;
  if (masks.some((mask) => contains(mask, box))) return true;

  /**
   * A grid rather than the four corners. Corners alone would pass a box
   * straddling two masks with an uncovered gap down the middle - which is
   * exactly the shape two adjacent masks with a margin between them produce.
   */
  const steps = 6;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const x = box.x + (box.width * i) / steps;
      const y = box.y + (box.height * j) / steps;
      if (!masks.some((mask) => containsPoint(mask, x, y))) return false;
    }
  }

  return true;
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON
  );
}

export function containsPoint(box: Box, x: number, y: number): boolean {
  return (
    x >= box.x - EPSILON &&
    x <= box.x + box.width + EPSILON &&
    y >= box.y - EPSILON &&
    y <= box.y + box.height + EPSILON
  );
}
