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

  /**
   * ── Producer identity: NAMES of environment variables, never the values ──
   *
   * These identify a **real licensed producer** and a real agency, and the
   * agency code doubles as that agency's encrypted TIN and the portal's account
   * id. docs/poc/sanitization.md says none of it may be committed - so it took
   * the same route the portal credentials already take: config holds the
   * variable NAME, `.env` (gitignored) holds the value, and it is resolved
   * through `ctx.secrets` at transaction start.
   *
   * They used to be plain values here, which meant the only way to run the
   * automation was to paste a real person's licence identity into a tracked
   * config file and remember to scrub it afterwards. That happened once and had
   * to be undone across seven files.
   */
  /** The writing-agent typeahead needs the producer's full name; the portal returns it with a middle initial. */
  producerFirstNameEnv: z.string().min(1),
  producerLastNameEnv: z.string().min(1),
  /**
   * Paid Agency auto-populates from the writing agent, so this is only ever
   * asserted, never typed. `paidAgencyName` used to sit alongside it and was
   * read by nothing at all - one fewer real value to handle, so it is gone.
   */
  paidAgencyCodeEnv: z.string().min(1),

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
   * `Member Enrollment Type` - the wizard step between Signature Format and the
   * Document Checklist.
   *
   * VERIFIED 2026-09-03 against the Application record's own picklist, which is
   * the field this step writes: the five options are exactly the values below,
   * and it sits at `--None--` until the step is answered.
   *
   * `Online Census Tool` is the default because it is the only value consistent
   * with what this automation has already declared upstream - the Attestation
   * screen selects "Online Census Enrollment (OCE)" for how the enrollment will
   * be submitted, and the Document Checklist carries a matching `Online Census
   * Tool` slot. Choosing anything else here would contradict the signed
   * application.
   *
   * Config rather than payload for the same reason as `typeOfBusiness`: it is a
   * property of how Gusto submits, not of the group. It becomes a payload field
   * the moment a second enrollment channel is used.
   */
  memberEnrollmentType: z.enum(['Online Census Tool', 'Ease', 'Real-Time', 'Simple Census', 'API']),

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
