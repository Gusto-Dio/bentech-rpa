import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_PLATFORM_CONFIG, type MfaConfig } from '../config/schema.ts';
import { createLogger } from '../logger.ts';
import { EnvSecretProvider, SecretResolver } from '../secrets.ts';
import { GmailApiMfaProvider } from './GmailApiMfaProvider.ts';
import { GmailUiMfaProvider } from './GmailUiMfaProvider.ts';
import { ImapMfaProvider } from './ImapMfaProvider.ts';
import { ManualMfaProvider } from './ManualMfaProvider.ts';
import { createMfaProvider } from './factory.ts';

const REPO_ROOT = '/repo';

function build(config: Partial<MfaConfig> = {}): ReturnType<typeof createMfaProvider> {
  return createMfaProvider({
    config: { ...DEFAULT_PLATFORM_CONFIG.mfa, ...config },
    logger: createLogger({ level: 'silent', pretty: false, base: {} }),
    secrets: new SecretResolver(new EnvSecretProvider()),
    repoRoot: REPO_ROOT,
  });
}

describe('createMfaProvider', () => {
  it('defaults to manual, so a misconfigured environment asks a human rather than reading mail', () => {
    assert.equal(DEFAULT_PLATFORM_CONFIG.mfa.provider, 'manual');
    assert.ok(build() instanceof ManualMfaProvider);
  });

  it('builds the UI provider for gmail-cdp, attached to a human\'s Chrome', () => {
    assert.ok(build({ provider: 'gmail-cdp' }) instanceof GmailUiMfaProvider);
  });

  it('builds the UI provider for gmail-profile', () => {
    assert.ok(build({ provider: 'gmail-profile' }) instanceof GmailUiMfaProvider);
  });

  it('builds the API provider for gmail-api', () => {
    assert.ok(build({ provider: 'gmail-api' }) instanceof GmailApiMfaProvider);
  });

  /**
   * The `imap` branch was the only one in the enum with no coverage here, so a
   * broken wiring - wrong config subtree, wrong provider returned - would have
   * surfaced only when a real run tried to read a mailbox.
   */
  it('builds the IMAP provider', () => {
    assert.ok(build({ provider: 'imap' }) instanceof ImapMfaProvider);
  });

  it('reports the provider it built, which is the field to look for in a run log', () => {
    assert.equal(build({ provider: 'gmail-cdp' }).name, 'gmail-cdp');
    assert.equal(build({ provider: 'gmail-profile' }).name, 'gmail-profile');
    assert.equal(build({ provider: 'gmail-api' }).name, 'gmail-api');
    assert.equal(build({ provider: 'imap' }).name, 'imap');
  });

  it('never touches a browser or the network just by being constructed', () => {
    // Initialize builds this before it knows whether a code will be needed at
    // all - the reuse path needs none - so construction has to be free.
    assert.doesNotThrow(() => build({ provider: 'gmail-cdp' }));
    assert.doesNotThrow(() => build({ provider: 'gmail-profile' }));
    assert.doesNotThrow(() => build({ provider: 'gmail-api' }));
    assert.doesNotThrow(() => build({ provider: 'imap' }));
  });

  it('resolves profileDir against the repo root, the way dataDir is resolved', () => {
    const expected = path.resolve(REPO_ROOT, DEFAULT_PLATFORM_CONFIG.mfa.profileDir);
    assert.equal(expected, '/repo/data/profiles/gmail-mfa');
  });
});
