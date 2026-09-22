import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderReference,
  ProviderRegistration,
} from "./types.js";

export interface SandboxConfig { endpoint?: string; image?: string; maxSeconds?: number }
export interface SandboxCreateRequest { image?: string; cpu?: number; memoryMb?: number; timeoutSeconds?: number }
export interface SandboxExecRequest { argv: string[]; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
export interface SandboxExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; providerOperationId?: string }
export interface SandboxFile { path: string; bytes: Uint8Array; contentType?: string }
export interface Sandbox extends AsyncDisposable {
  readonly id: string;
  exec(request: SandboxExecRequest, context: ProviderOperationContext): Promise<SandboxExecResult>;
  readFile(path: string, context: ProviderOperationContext): Promise<Uint8Array>;
  writeFile(file: SandboxFile, context: ProviderOperationContext): Promise<void>;
}
export interface SandboxClient extends AsyncDisposable {
  create(request: SandboxCreateRequest, context: ProviderOperationContext): Promise<Sandbox>;
  get(id: string, context: ProviderOperationContext): Promise<Sandbox>;
}
export interface SandboxDriver extends ProviderRegistration<SandboxConfig, SandboxClient> {
  readonly module: "sandbox";
  readonly config: ProviderConfigDefinition<SandboxConfig>;
}
