import { SystemException } from './errors.ts';

/**
 * ── VAULT SEAM ───────────────────────────────────────────────────────────────
 * Everything credential-shaped goes through this interface. Today the only
 * implementation reads process.env. Swapping in a real secrets manager means
 * writing one class here and changing one line in the runner - no automation
 * changes at all, because automations only ever see `ctx.secrets`.
 *
 * Config files store the NAME of a secret ("usernameEnv": "SAUCE_USERNAME"),
 * never the value. That indirection is what makes this swap possible, and it is
 * why no config file in this repo needs to be treated as sensitive.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/** A username/password pair, as Orchestrator Credential assets model it. */
export interface Credential {
  username: string;
  password: string;
}

export interface SecretProvider {
  readonly name: string;
  get(key: string): Promise<string | undefined>;

  /**
   * Optional capability. Environment variables cannot express a credential
   * pair in one lookup, so EnvSecretProvider does not implement it; the
   * Orchestrator assets provider does. Callers use
   * SecretResolver.requireCredential(), which reports the gap clearly rather
   * than returning half a credential.
   */
  getCredential?(key: string): Promise<Credential | undefined>;
}

export class EnvSecretProvider implements SecretProvider {
  readonly name = 'env';

  async get(key: string): Promise<string | undefined> {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
  }
}

export class SecretResolver {
  readonly #provider: SecretProvider;
  readonly #cache = new Map<string, string>();

  constructor(provider: SecretProvider = new EnvSecretProvider()) {
    this.#provider = provider;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  /**
   * A missing credential is a SystemException, not a BusinessException: the
   * environment is misconfigured, and no amount of different input data would
   * fix it. It surfaces during Initialize and aborts the run before any
   * transaction is touched.
   */
  async require(key: string): Promise<string> {
    const value = await this.optional(key);
    if (value === undefined) {
      throw new SystemException(
        `Secret "${key}" is not available from the "${this.#provider.name}" provider`,
        { details: { secretName: key, provider: this.#provider.name } },
      );
    }
    return value;
  }

  async optional(key: string): Promise<string | undefined> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const value = await this.#provider.get(key);
    if (value !== undefined) this.#cache.set(key, value);
    return value;
  }

  /**
   * Resolves a username/password pair.
   *
   * Fails with an explicit SystemException when the provider cannot serve
   * credentials at all - which is the common case, because reading an
   * Orchestrator Credential asset requires robot context. Silently returning
   * an empty password would turn a configuration problem into a mysterious
   * authentication failure inside a portal automation.
   */
  async requireCredential(key: string): Promise<Credential> {
    const credential = await this.optionalCredential(key);
    if (credential === undefined) {
      throw new SystemException(
        `Credential "${key}" is not available from the "${this.#provider.name}" provider`,
        { details: { secretName: key, provider: this.#provider.name } },
      );
    }
    return credential;
  }

  async optionalCredential(key: string): Promise<Credential | undefined> {
    if (this.#provider.getCredential === undefined) {
      throw new SystemException(
        `Secret provider "${this.#provider.name}" cannot serve credential pairs. ` +
          'Use two separate secrets, or configure a provider that supports credentials.',
        { details: { secretName: key, provider: this.#provider.name } },
      );
    }

    const credential = await this.#provider.getCredential(key);
    if (credential !== undefined) {
      // Cached under a distinct key so a credential username can never be
      // returned by a plain get() of the same name.
      this.#cache.set(`credential:${key}:username`, credential.username);
    }
    return credential;
  }
}
