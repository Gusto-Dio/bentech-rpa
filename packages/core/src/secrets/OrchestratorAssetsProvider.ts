import type { Logger } from 'pino';
import { SystemException } from '../errors.ts';
import type { OrchestratorClient } from '../orchestrator/OrchestratorClient.ts';
import type { Credential, SecretProvider } from '../secrets.ts';

/**
 * Reads Orchestrator Assets as secrets.
 *
 * Useful for non-sensitive configuration that operations already manages in
 * Orchestrator - an endpoint, a batch size, a feature toggle.
 *
 * For genuinely sensitive values, a dedicated secrets manager remains the
 * recommendation, for the reason spelled out on getCredential() below. The
 * SecretProvider interface exists precisely so that swapping this for a Vault
 * or AWS Secrets Manager adapter touches one class and no automation.
 */

interface AssetDto {
  Id: number;
  Name: string;
  /** Text | Integer | Bool | Credential | WindowsCredential | KeyValueList */
  ValueType?: string | null;
  Value?: string | null;
  StringValue?: string | null;
  IntValue?: number | null;
  BoolValue?: boolean | null;
  CredentialUsername?: string | null;
  /** Always null from the generic /odata/Assets endpoint. See getCredential(). */
  CredentialPassword?: string | null;
}

interface ODataList<T> {
  value?: T[];
}

export interface OrchestratorAssetsProviderOptions {
  client: OrchestratorClient;
  logger: Logger;
  /** Unattended robot key. Without it, credential assets cannot be read at all. */
  robotIdentifier?: string | undefined;
}

export class OrchestratorAssetsProvider implements SecretProvider {
  readonly name = 'orchestrator-assets';

  readonly #client: OrchestratorClient;
  readonly #logger: Logger;
  readonly #robotIdentifier: string | undefined;

  constructor(options: OrchestratorAssetsProviderOptions) {
    this.#client = options.client;
    this.#logger = options.logger.child({ component: 'orchestrator-assets' });
    this.#robotIdentifier = options.robotIdentifier;
  }

  async get(key: string): Promise<string | undefined> {
    const asset = await this.#findAsset(key);
    if (asset === undefined) return undefined;

    const valueType = asset.ValueType ?? 'Text';

    if (valueType === 'Credential' || valueType === 'WindowsCredential') {
      // Returning the username here would be a trap: the caller asked for a
      // secret and would get half a credential with no indication.
      throw new SystemException(
        `Asset "${key}" is a ${valueType} asset. Use secrets.requireCredential("${key}") instead of get().`,
        { details: { assetName: key, valueType } },
      );
    }

    switch (valueType) {
      case 'Text':
        return asset.StringValue ?? asset.Value ?? undefined;
      case 'Integer':
        return asset.IntValue === null || asset.IntValue === undefined
          ? undefined
          : String(asset.IntValue);
      case 'Bool':
        return asset.BoolValue === null || asset.BoolValue === undefined
          ? undefined
          : String(asset.BoolValue);
      default:
        // TODO(orchestrator): KeyValueList and any newer asset types are not
        // mapped. Confirm which types your tenant actually uses.
        this.#logger.warn({ assetName: key, valueType }, 'Unsupported asset value type');
        return asset.Value ?? asset.StringValue ?? undefined;
    }
  }

  /**
   * Reads a Credential asset's username AND password.
   *
   * ── The caveat that matters ──────────────────────────────────────────────
   * The generic `GET /odata/Assets` endpoint returns `CredentialPassword: null`
   * by design. Orchestrator only releases a credential password under **robot
   * context**, so this method requires a robot identifier and uses the
   * robot-scoped endpoint.
   *
   * Consequence: a plain External Application, with no robot identity, cannot
   * read credential assets at all. That is not a bug to work around - it is why
   * the recommendation for sensitive secrets is an external secrets manager
   * behind this same SecretProvider interface, rather than Credential assets.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getCredential(key: string): Promise<Credential | undefined> {
    if (this.#robotIdentifier === undefined || this.#robotIdentifier === '') {
      throw new SystemException(
        `Cannot read Credential asset "${key}": Orchestrator only returns a credential password under ` +
          'robot context, and no robot identifier is configured (queue.robotIdentifierEnv). ' +
          'The generic /odata/Assets endpoint always returns CredentialPassword: null. ' +
          'For sensitive secrets prefer an external secrets manager behind SecretProvider.',
        { details: { assetName: key, provider: this.name } },
      );
    }

    /**
     * TODO(orchestrator): the robot-scoped operation name has moved between
     * versions (GetRobotAssetByNameForRobotKey, GetRobotAssetByRobotKey and
     * variants). Confirm yours with `rpa orchestrator check` before relying on
     * credential assets in production.
     */
    const asset = await this.#client.odataAction<AssetDto | undefined>(
      '/Assets/UiPath.Server.Configuration.OData.GetRobotAssetByNameForRobotKey',
      { robotKey: this.#robotIdentifier, assetName: key },
    );

    if (asset === undefined || asset === null) return undefined;

    const username = asset.CredentialUsername ?? undefined;
    const password = asset.CredentialPassword ?? undefined;

    if (username === undefined || password === undefined) {
      throw new SystemException(
        `Credential asset "${key}" came back without a complete username/password pair. ` +
          'This usually means the robot identity is not entitled to it, or the asset is not ' +
          'assigned to this robot in the configured folder.',
        { details: { assetName: key, hasUsername: username !== undefined } },
      );
    }

    // Never log the password, nor its length.
    this.#logger.debug({ assetName: key }, 'Resolved credential asset under robot context');
    return { username, password };
  }

  async #findAsset(name: string): Promise<AssetDto | undefined> {
    const escaped = name.replace(/'/g, "''");
    const page = await this.#client.odataGet<ODataList<AssetDto>>('/Assets', {
      $filter: `Name eq '${escaped}'`,
      $top: 1,
    });
    return (page.value ?? [])[0];
  }
}
