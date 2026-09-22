import type {
  AsyncDisposable,
  ProviderBlob,
  ProviderConfigDefinition,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface StorageConfig {
  endpoint?: string | undefined;
  bucket?: string | undefined;
  region?: string | undefined;
  /** Credential-vault reference for the caller-owned S3 access key ID. */
  accessKeyIdSecret?: string | undefined;
  /** Credential-vault reference for the caller-owned S3 secret access key. */
  secretAccessKeySecret?: string | undefined;
  /** Optional credential-vault reference for a caller-owned session token. */
  sessionTokenSecret?: string | undefined;
  maxObjectBytes?: number | undefined;
  maxSignedUrlSeconds?: number | undefined;
  /** Optional exact content-type allowlist enforced before upload. */
  allowedContentTypes?: string[] | undefined;
}
export interface StoragePutRequest {
  key: string;
  blob: ProviderBlob;
  metadata?: Record<string, string>;
}
export interface StorageObject {
  key: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string;
  etag?: string;
}
export interface StorageClient extends AsyncDisposable {
  put(request: StoragePutRequest, context: ProviderOperationContext): Promise<StorageObject>;
  head(key: string, context: ProviderOperationContext): Promise<StorageObject>;
  get(key: string, context: ProviderOperationContext): Promise<ProviderBlob>;
  delete(key: string, context: ProviderOperationContext): Promise<void>;
  createDownloadUrl(
    key: string,
    expiresInSeconds: number,
    context: ProviderOperationContext,
  ): Promise<string>;
}
export interface StorageDriver extends ProviderRegistration<StorageConfig, StorageClient> {
  readonly module: "storage";
  readonly config: ProviderConfigDefinition<StorageConfig>;
}
