/**
 * Shared code for the __DOMAIN_TITLE__ domain.
 *
 * What belongs here: anything more than one __DOMAIN__ automation needs - a
 * portal login page object, a plan-code lookup, a domain business rule.
 *
 * What does not: anything only one automation uses (keep it in that automation),
 * and anything the whole platform needs (that belongs in @rpa/core, via the
 * platform team).
 *
 * Import boundaries are enforced by `rpa validate`: only __DOMAIN__ automations
 * can import this package.
 */

export const DOMAIN = '__DOMAIN__';

/**
 * Placeholder so the package has a real export from day one. Replace it with
 * the first thing two automations in this domain both need.
 */
export function describeDomain(): string {
  return '__DOMAIN_TITLE__';
}
