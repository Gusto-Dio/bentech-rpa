import { z } from 'zod';

/**
 * automation.json - the machine-readable registry entry for one automation.
 *
 * This file is what makes a tree of 100+ automations governable instead of
 * merely large. It is read by `rpa list`/`rpa run`, by CI validation, by alert
 * routing (owners, criticality) and later by the scheduler (schedule). Adding a
 * field here is how the platform grows a capability across every automation at
 * once, rather than through 100 copy-paste edits.
 */

/** Folder and id segments are kebab-case. macOS would tolerate GroupSubmission; Ubuntu would not. */
export const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const AUTOMATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]\/[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const criticalitySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Criticality = z.infer<typeof criticalitySchema>;

export const automationManifestSchema = z.strictObject({
  /** "<domain>/<name>", and must match the folder path it was found in. */
  id: z.string().regex(AUTOMATION_ID_PATTERN, 'must be "<domain>/<name>" in kebab-case'),
  /** Human-readable. The folder name is the machine identifier; this is for people. */
  name: z.string().min(3),
  description: z.string().default(''),
  /** Process type, e.g. group-submission. Must match the parent folder. */
  domain: z.string().regex(SEGMENT_PATTERN, 'must be kebab-case'),
  /** GitHub teams or handles. Drives CODEOWNERS review routing and alert routing. */
  owners: z.array(z.string().min(1)).min(1),
  criticality: criticalitySchema,
  /**
   * 'none' skips the browser launch entirely. Plenty of automations are
   * file/API work, and paying Chromium's startup cost and memory for those is
   * pure waste. To add a third kind, implement Session and extend this enum.
   */
  sessionKind: z.enum(['browser', 'none']),
  entry: z.string().min(1).default('src/index.ts'),
  queue: z.strictObject({
    name: z.string().min(1),
    /** Overrides the platform maxRetries for this automation only. */
    maxRetries: z.number().int().min(0).max(10).optional(),
  }),
  /** Declared here, executed by the future scheduler. Nothing reads it at runtime yet. */
  schedule: z
    .strictObject({
      cron: z.string().min(9),
      timezone: z.string().min(3),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});

export type AutomationManifest = z.infer<typeof automationManifestSchema>;

export interface ManifestIssue {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Cross-checks the manifest against where it actually lives. These catch the
 * single most common mistake when automations are created by copying a sibling:
 * a manifest that still carries the source automation's id.
 */
export function checkManifestLocation(
  manifest: AutomationManifest,
  location: { domainDir: string; automationDir: string },
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const expectedId = `${location.domainDir}/${location.automationDir}`;

  if (!SEGMENT_PATTERN.test(location.domainDir)) {
    issues.push({
      level: 'error',
      message: `domain folder "${location.domainDir}" is not kebab-case (Ubuntu is case-sensitive; macOS will not warn you)`,
    });
  }
  if (!SEGMENT_PATTERN.test(location.automationDir)) {
    issues.push({
      level: 'error',
      message: `automation folder "${location.automationDir}" is not kebab-case`,
    });
  }
  if (manifest.id !== expectedId) {
    issues.push({
      level: 'error',
      message: `id "${manifest.id}" does not match its location, expected "${expectedId}" (copied from another automation?)`,
    });
  }
  if (manifest.domain !== location.domainDir) {
    issues.push({
      level: 'error',
      message: `domain "${manifest.domain}" does not match parent folder "${location.domainDir}"`,
    });
  }

  const conventionalQueue = `${location.domainDir}.${location.automationDir}`;
  if (manifest.queue.name !== conventionalQueue) {
    issues.push({
      level: 'warning',
      message: `queue.name "${manifest.queue.name}" departs from the convention "${conventionalQueue}"`,
    });
  }

  return issues;
}
