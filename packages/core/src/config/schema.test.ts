import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imapConfigSchema } from './schema.ts';
/**
 * The IMAP credential rule, which was wrong in a way only reachable through the
 * loader: `DEFAULT_PLATFORM_CONFIG` supplies `passwordEnv` and deep-merge cannot
 * remove it, so requiring "exactly one" made the documented OAuth path
 * impossible to select from any config layer.
 */
describe('imapConfigSchema - credential selection', () => {
  const base = { host: 'imap.gmail.com', port: 993, secure: true, userEnv: 'MFA_IMAP_USER' };

  it('accepts an app password on its own', () => {
    assert.equal(imapConfigSchema.safeParse({ ...base, passwordEnv: 'P' }).success, true);
  });

  it('accepts an access token on its own', () => {
    assert.equal(imapConfigSchema.safeParse({ ...base, accessTokenEnv: 'T' }).success, true);
  });

  /**
   * The case that matters: adding accessTokenEnv to a JSON layer leaves the code
   * default's passwordEnv in place, so both arrive. It must be accepted, and the
   * provider uses the token.
   */
  it('accepts BOTH, because that is the only way a layer can ask for OAuth', () => {
    assert.equal(
      imapConfigSchema.safeParse({ ...base, passwordEnv: 'P', accessTokenEnv: 'T' }).success,
      true,
    );
  });

  it('rejects neither, which would fail at the first login instead of at startup', () => {
    const result = imapConfigSchema.safeParse(base);
    assert.equal(result.success, false);
  });
});
