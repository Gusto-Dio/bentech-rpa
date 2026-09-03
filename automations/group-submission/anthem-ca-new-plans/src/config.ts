import { z } from 'zod';

/**
 * Anthem CA settings, validated at Initialize.
 *
 * Everything that identifies Gusto as the producing agency lives here rather
 * than in code, because it is environment data that Benefits owns and that
 * changes without a code release. Credentials appear only as env-var NAMES.
 */
export const automationConfigSchema = z.strictObject({
  /** The Producer Toolbox LOGIN page. www.anthem.com/ca/producer is marketing, not a login. */
  portalUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),

  /**
   * A URL only a signed-in producer can load, used to probe a stored session.
   *
   * Configured rather than derived because the dashboard path carries an
   * account identifier. "Cookies exist" is not "we are signed in", so this has
   * to be a real page load.
   */
  signedInProbeUrl: z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL'),

  /** NAMES of the credential variables. Values come from ctx.secrets. */
  usernameEnv: z.string().min(1),
  passwordEnv: z.string().min(1),

  // ── Producer identity, entered on the license & contract validation screen ──
  /** The portal's broker search is by first name, then you pick from the results. */
  producerFirstName: z.string().min(1),
  producerLastName: z.string().min(1),
  /** Selected under "Paid Agency". The code is part of the displayed option text. */
  paidAgencyName: z.string().min(1),
  paidAgencyCode: z.string().min(1),

  // ── MFA ──
  /** Gmail label the carrier's MFA mail is filtered into. */
  mfaLabel: z.string().min(1),
  mfaSenderAllowList: z.array(z.string().min(1)).min(1),
  /**
   * Extra narrowing, because the label collects more than codes.
   *
   * Anthem's own MFA screen states the subject verbatim: "You'll receive an
   * email from noreply@broker.anthem.com with the subject 'One-Time Security
   * Code.'" A forwarded copy keeps that substring, so this matches both the
   * direct mail and the forward.
   */
  mfaSubjectContains: z.string().min(1).optional(),
  /** Total budget for obtaining a code, across every resend. */
  mfaTimeoutMs: z.number().int().min(10_000),
  /**
   * Wait this long for one code before asking the portal to resend.
   *
   * Must sit BELOW Anthem's expiry countdown - past it the code is rejected on
   * arrival, so waiting only fails more slowly.
   */
  mfaResendAfterMs: z.number().int().min(10_000).optional(),
  /** Extra codes to request when one does not arrive. 0 disables resending. */
  mfaMaxResends: z.number().int().min(0).max(5).optional(),

  /**
   * "Type of Business (Be Specific)" on the employer application.
   *
   * A STOPGAP, and it should not survive contact with real groups: this is
   * group-specific data - the OA reads it off the Task List / QA sheet - and the
   * shared payload has no field for it. Putting it in config means every group
   * submitted from this environment claims the same line of business, which is
   * wrong for anything but the synthetic PoC group.
   *
   * See docs/poc/anthem-ca-new-plans/open-questions.md: the payload schema needs
   * a `typeOfBusiness`, and this field goes away when it has one.
   */
  typeOfBusiness: z.string().min(1),

  // ── Portal limits, which become business rules ──
  /** The portal truncates or refuses beyond this. Source doc: "use your best judgment to shrink". */
  maxGroupNameLength: z.number().int().positive(),
  /** Anthem's hard limit, including spaces. Source doc FAQ. */
  maxAddressLength: z.number().int().positive(),

  /**
   * ── SAFETY GUARD ──
   * false means the automation stops before anything irreversible: the
   * DocuSign signature, and any Submit/Uploads Complete control. The PoC runs
   * against the PRODUCTION portal, so this defaults to false and flipping it
   * is a deliberate act.
   */
  allowSubmit: z.boolean(),
});

export type AutomationConfig = z.infer<typeof automationConfigSchema>;
