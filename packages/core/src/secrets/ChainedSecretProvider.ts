import type { Credential, SecretProvider } from '../secrets.ts';

/**
 * Tries several providers in order, first hit wins.
 *
 * The intended arrangement is environment variables first, then Orchestrator
 * assets. That way a developer's `.env` transparently overrides whatever the
 * tenant holds - useful for pointing one automation at a sandbox without
 * touching shared configuration - while a deployed run, which has no `.env`,
 * falls through to Orchestrator.
 */
export class ChainedSecretProvider implements SecretProvider {
  readonly name: string;
  readonly #providers: readonly SecretProvider[];

  constructor(providers: readonly SecretProvider[]) {
    if (providers.length === 0) throw new Error('ChainedSecretProvider needs at least one provider');
    this.#providers = providers;
    this.name = `chain(${providers.map((provider) => provider.name).join(' -> ')})`;
  }

  async get(key: string): Promise<string | undefined> {
    for (const provider of this.#providers) {
      const value = await provider.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /**
   * Only consults providers that actually support credentials, so a chain
   * beginning with the env provider does not fail on its behalf.
   */
  async getCredential(key: string): Promise<Credential | undefined> {
    const capable = this.#providers.filter((provider) => provider.getCredential !== undefined);
    if (capable.length === 0) return undefined;

    for (const provider of capable) {
      const credential = await provider.getCredential?.(key);
      if (credential !== undefined) return credential;
    }
    return undefined;
  }
}
