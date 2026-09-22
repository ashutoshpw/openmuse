import type {
  AsyncDisposable,
  ProviderBlob,
  ProviderConfigDefinition,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface StorageConfig {
  endpoint?: string;
  bucket?: string;
  region?: string;
  maxObjectBytes?: number;
  maxSignedUrlSeconds?: number;
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
