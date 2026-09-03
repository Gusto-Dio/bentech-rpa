import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { SystemException } from '../errors.ts';
import type { OrchestratorClient } from './OrchestratorClient.ts';

/**
 * Orchestrator Storage Buckets.
 *
 * Both directions are a two-step flow, and the reason is worth understanding:
 * Orchestrator does not proxy the bytes. It hands back a short-lived, signed
 * URI pointing at the underlying storage (Azure Blob, S3, or Orchestrator's own
 * store), and the transfer happens directly against that URI. So the second
 * request must NOT carry the Orchestrator bearer token - on some backends an
 * unexpected Authorization header invalidates the signature.
 *
 * Writing requires the **OR.Administration** scope on the External Application.
 */

export interface BucketClientOptions {
  client: OrchestratorClient;
  logger: Logger;
}

interface BucketDto {
  Id: number;
  Name: string;
  Identifier?: string | null;
}

interface ODataList<T> {
  value?: T[];
}

/**
 * TODO(orchestrator): `Headers` comes back as a plain object on some versions
 * and as parallel `{ Keys, Values }` arrays on others. Both shapes are handled
 * by readRequiredHeaders() below; confirm which yours returns so the dead
 * branch can eventually go.
 */
interface StorageUriDto {
  Uri: string;
  /** PUT for writes, GET for reads - but read it from the response, do not assume. */
  Verb?: string | null;
  Headers?: Record<string, string> | { Keys?: string[]; Values?: string[] } | null;
  RequiresAuth?: boolean | null;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

export class BucketClient {
  readonly #client: OrchestratorClient;
  readonly #logger: Logger;
  readonly #idCache = new Map<string, number>();

  constructor(options: BucketClientOptions) {
    this.#client = options.client;
    this.#logger = options.logger.child({ component: 'orchestrator-buckets' });
  }

  /** Accepts a bucket name, or a numeric id as a string. Resolved ids are cached per run. */
  async resolveBucketId(bucketKeyOrName: string): Promise<number> {
    const numeric = Number(bucketKeyOrName);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;

    const cached = this.#idCache.get(bucketKeyOrName);
    if (cached !== undefined) return cached;

    const escaped = bucketKeyOrName.replace(/'/g, "''");
    const page = await this.#client.odataGet<ODataList<BucketDto>>('/Buckets', {
      $filter: `Name eq '${escaped}'`,
      $top: 1,
    });

    const bucket = (page.value ?? [])[0];
    if (bucket === undefined) {
      throw new SystemException(
        `Storage bucket "${bucketKeyOrName}" was not found in the configured Orchestrator folder`,
        { details: { bucket: bucketKeyOrName } },
      );
    }

    this.#idCache.set(bucketKeyOrName, bucket.Id);
    return bucket.Id;
  }

  async upload(input: {
    bucket: string;
    /** Path within the bucket, e.g. "runs/2026-09-02/SUB-1004/screenshot.png". */
    path: string;
    contentType: string;
    data: Uint8Array;
  }): Promise<void> {
    const bucketId = await this.resolveBucketId(input.bucket);

    const target = await this.#client.odataGet<StorageUriDto>(
      `/Buckets(${bucketId})/UiPath.Server.Configuration.OData.GetWriteUri`,
      { path: input.path, contentType: input.contentType },
    );

    await this.#transfer(target, {
      defaultVerb: 'PUT',
      body: input.data,
      contentType: input.contentType,
      description: `upload ${input.path}`,
    });

    this.#logger.info(
      { bucket: input.bucket, path: input.path, bytes: input.data.byteLength },
      'Uploaded to storage bucket',
    );
  }

  async download(input: { bucket: string; path: string }): Promise<Uint8Array> {
    const bucketId = await this.resolveBucketId(input.bucket);

    const target = await this.#client.odataGet<StorageUriDto>(
      `/Buckets(${bucketId})/UiPath.Server.Configuration.OData.GetReadUri`,
      { path: input.path },
    );

    const response = await this.#transfer(target, {
      defaultVerb: 'GET',
      description: `download ${input.path}`,
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    this.#logger.info(
      { bucket: input.bucket, path: input.path, bytes: bytes.byteLength },
      'Downloaded from storage bucket',
    );
    return bytes;
  }

  async uploadFile(
    bucket: string,
    bucketPath: string,
    localFile: string,
    contentType?: string,
  ): Promise<void> {
    const data = await readFile(localFile);
    await this.upload({
      bucket,
      path: bucketPath,
      contentType: contentType ?? guessContentType(localFile),
      data: new Uint8Array(data),
    });
  }

  async downloadFile(bucket: string, bucketPath: string, localFile: string): Promise<void> {
    const bytes = await this.download({ bucket, path: bucketPath });
    await writeFile(localFile, bytes);
  }

  async #transfer(
    target: StorageUriDto,
    options: {
      defaultVerb: 'PUT' | 'GET';
      body?: Uint8Array;
      contentType?: string;
      description: string;
    },
  ): Promise<Response> {
    if (target.Uri === undefined || target.Uri === null || target.Uri.length === 0) {
      throw new SystemException(
        `Orchestrator returned no storage URI for ${options.description}. ` +
          'Writing to a bucket requires the OR.Administration scope on the External Application.',
      );
    }

    const headers = readRequiredHeaders(target.Headers);
    if (options.contentType !== undefined) headers['Content-Type'] = options.contentType;

    return this.#client.rawRequest(
      target.Uri,
      {
        // Use the verb Orchestrator specified; the storage backend signs for it.
        method: (target.Verb ?? options.defaultVerb).toUpperCase(),
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
      },
      // The URI is normally pre-signed and must stay unauthenticated. When
      // Orchestrator itself is the storage endpoint it says so explicitly.
      { authenticate: target.RequiresAuth === true },
    );
  }
}

/** Accepts both the plain-object and the parallel-arrays shapes. */
export function readRequiredHeaders(
  raw: StorageUriDto['Headers'],
): Record<string, string> {
  if (raw === null || raw === undefined) return {};

  const parallel = raw as { Keys?: string[]; Values?: string[] };
  if (Array.isArray(parallel.Keys) && Array.isArray(parallel.Values)) {
    const headers: Record<string, string> = {};
    parallel.Keys.forEach((key, index) => {
      const value = parallel.Values?.[index];
      if (value !== undefined) headers[key] = value;
    });
    return headers;
  }

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') flat[key] = value;
  }
  return flat;
}

function guessContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
