import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderOperationContext,
  ProviderCreateContext,
  ProviderRegistration,
} from "./types.js";

export type SandboxStatus = "creating" | "running" | "stopped" | "destroyed" | "unknown";

export interface SandboxLimits {
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
  pids?: number;
  timeoutSeconds?: number;
}

export interface SandboxConfig {
  endpoint?: string;
  image?: string;
  /** Hosted execution is deliberately not supported by the Docker provider. */
  hosted?: boolean;
  allowedImages?: string[];
  maxLimits?: SandboxLimits;
  maxSeconds?: number;
  maxFileBytes?: number;
  maxOutputBytes?: number;
}

export interface SandboxCreateRequest {
  /** A request may repeat the binding for auditability; the provider must
   * compare it with ProviderCreateContext.workspaceId. */
  workspaceId?: string;
  image?: string;
  limits?: SandboxLimits;
  /** Kept as aliases for the initial contract and older callers. */
  cpu?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
}

export interface SandboxExecRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  providerOperationId?: string;
}

export interface SandboxMetadata {
  id: string;
  providerId: string;
  workspaceId: string;
  image?: string;
  status: SandboxStatus;
  createdAt?: string;
  expiresAt?: string;
  limits: SandboxLimits;
}

export interface SandboxFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}
export interface Sandbox extends AsyncDisposable {
  readonly id: string;
  readonly metadata: SandboxMetadata;
  exec(request: SandboxExecRequest, context: ProviderOperationContext): Promise<SandboxExecResult>;
  execute(
    request: SandboxExecRequest,
    context: ProviderOperationContext,
  ): Promise<SandboxExecResult>;
  readFile(path: string, context: ProviderOperationContext): Promise<Uint8Array>;
  writeFile(file: SandboxFile, context: ProviderOperationContext): Promise<void>;
  destroy(context?: ProviderOperationContext): Promise<void>;
}
export interface SandboxClient extends AsyncDisposable {
  create(request: SandboxCreateRequest, context: ProviderOperationContext): Promise<Sandbox>;
  get(id: string, context: ProviderOperationContext): Promise<Sandbox>;
  reconnect(id: string, context: ProviderOperationContext): Promise<Sandbox>;
  destroy(id: string, context: ProviderOperationContext): Promise<void>;
}
export interface SandboxDriver extends ProviderRegistration<SandboxConfig, SandboxClient> {
  readonly module: "sandbox";
  readonly config: ProviderConfigDefinition<SandboxConfig>;
  create(config: SandboxConfig, context: ProviderCreateContext): Promise<SandboxClient>;
}
