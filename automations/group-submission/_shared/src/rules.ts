import { BusinessException } from '@rpa/core';

/**
 * Business rules shared by every group-submission automation.
 *
 * Keeping them here, as pure functions, means they are the same rule everywhere
 * and can be reasoned about without a browser. Rules that only one automation
 * needs stay in that automation.
 */

/** Internal group identifier, e.g. GRP-8842. Never a tax id - see the PII note in docs. */
const GROUP_ID_PATTERN = /^GRP-\d{4,8}$/;

export function assertValidGroupId(groupId: string): void {
  if (!GROUP_ID_PATTERN.test(groupId)) {
    throw new BusinessException(`Group id "${groupId}" is not in the expected GRP-NNNN form`, {
      details: { groupId },
    });
  }
}

/**
 * A submission with nothing in it is a data problem upstream, not a portal
 * problem, so it is a business failure: the portal would reject it too, and
 * retrying cannot add the missing lines.
 */
export function assertHasRequestedItems(items: readonly string[]): void {
  if (items.length === 0) {
    throw new BusinessException('Submission has no requested plans');
  }
}
