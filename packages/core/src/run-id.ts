import crypto from 'node:crypto';

/**
 * `20260911T140211Z-a1b2c3` - the id that names an evidence directory.
 *
 * Extracted from the runner so the sentinel can mint the same shape. That
 * matters more than it looks: sentinel evidence lands in `artifacts/` beside
 * real run evidence, and an operator grepping or sorting that directory at
 * 03:00 should not have to know which subsystem wrote which entry.
 *
 * Compacted ISO rather than an epoch, because the first thing anyone asks of a
 * directory name is "when", and six hex characters rather than a full UUID
 * because the timestamp already carries the ordering - the suffix only has to
 * break ties between two runs starting in the same second.
 */
export function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomUUID().slice(0, 6)}`;
}
