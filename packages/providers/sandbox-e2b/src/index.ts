import { z } from "zod";
import {
  ProviderOperationError,
  type ProviderCreateContext,
  type ProviderOperationContext,
  type Sandbox,
  type SandboxClient,
  type SandboxConfig,
  type SandboxCreateRequest,
  type SandboxDriver,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxFile,
  type SandboxLimits,
  type SandboxMetadata,
} from "@openmuse/provider-contracts";

/** Structural view of the official e2b 2.48.0 SDK used at the adapter edge. */
export interface E2BSandboxInfo {
  sandboxId: string;
  templateId: string;
  metadata: Readonly<Record<string, string>>;
  startedAt?: Date;
  endAt?: Date;
  state?: "running" | "paused" | string;
  cpuCount?: number;
  memoryMB?: number;
}

export interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface E2BCommandHandle extends Partial<E2BCommandResult> {
  readonly pid: number;
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
}

export interface E2BCommandStartOptions {
  background: true;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
}

export interface E2BCommands {
  run(command: string, options: E2BCommandStartOptions): Promise<E2BCommandHandle>;
}

export interface E2BFileInfo {
  type?: string;
  symlinkTarget?: string;
}

export interface E2BFiles {
  read(
    path: string,
    options: { format: "bytes"; requestTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  write(
    path: string,
    data: ArrayBuffer,
    options?: { requestTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  getInfo?(
    path: string,
    options?: { requestTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<E2BFileInfo>;
}

export interface E2BSandbox {
  readonly sandboxId: string;
  readonly files: E2BFiles;
  readonly commands: E2BCommands;
  getInfo(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<E2BSandboxInfo>;
  kill(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
  setTimeout(
    timeoutMs: number,
    options?: { requestTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;
}

export interface E2BSandboxClass {
  create(template: string, options?: E2BCreateOptions): Promise<E2BSandbox>;
  connect(id: string, options?: E2BConnectOptions): Promise<E2BSandbox>;
  getInfo(id: string, options?: E2BRequestOptions): Promise<E2BSandboxInfo>;
  kill(id: string, options?: E2BRequestOptions): Promise<boolean>;
}

export interface E2BCreateOptions {
  metadata?: Record<string, string>;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface E2BConnectOptions {
  timeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface E2BRequestOptions {
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface E2BClientFactory {
  create(options: { apiKey: string; domain?: string; apiUrl?: string }): Promise<E2BSandboxClass>;
}

export interface OfficialE2BConstructor {
  new (options: { apiKey: string; domain?: string; apiUrl?: string }): {
    Sandbox: E2BSandboxClass;
  };
}

export function createOfficialE2BFactory(E2B: OfficialE2BConstructor): E2BClientFactory {
  return {
    async create(options) {
      return new E2B(options).Sandbox;
    },
  };
}

export interface E2BSandboxDriverOptions {
  factory?: E2BClientFactory;
  providerId?: string;
  /** Stable composition-root identity used to prevent cross-instance reuse. */
  instanceId?: string;
  displayName?: string;
}

const limitsSchema = z
  .object({
    cpu: z.number().finite().positive().max(8).optional(),
    memoryMb: z.number().int().positive().max(16_384).optional(),
    diskMb: z.number().int().positive().max(100_000).optional(),
    pids: z.number().int().positive().max(4_096).optional(),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .max(15 * 60)
      .optional(),
  })
  .strict();

const configSchema = z
  .object({
    endpoint: z.string().url().optional(),
    apiKeySecret: z.string().trim().min(1),
    domain: z.string().trim().min(1).optional(),
    template: z.string().trim().min(1).optional(),
    /** Alias matching the shared SandboxConfig vocabulary. */
    image: z.string().trim().min(1).optional(),
    allowedTemplates: z.array(z.string().trim().min(1)).max(100).default([]),
    /** Alias matching the shared SandboxConfig vocabulary. */
    allowedImages: z.array(z.string().trim().min(1)).max(100).default([]),
    maxLimits: limitsSchema.optional(),
    maxSeconds: z
      .number()
      .int()
      .positive()
      .max(15 * 60)
      .default(15 * 60),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .default(2 * 1024 * 1024),
  })
  .strict();

const defaultLimits: Required<SandboxLimits> = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 512,
  pids: 128,
  timeoutSeconds: 60,
};

const controlTimeoutMs = 30_000;

interface E2BConfig extends SandboxConfig {
  endpoint?: string;
  apiKeySecret: string;
  domain?: string;
  template?: string;
  image?: string;
  allowedTemplates: string[];
  allowedImages: string[];
  maxSeconds: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

interface E2BBinding {
  providerId: string;
  instanceId: string;
  workspaceId: string;
  tenantId?: string;
  userId?: string;
}

type E2BOutcome<T> = { kind: "value"; value: T } | { kind: "timeout" } | { kind: "aborted" };

function providerError(
  providerId: string,
  operation: string,
  code: ConstructorParameters<typeof ProviderOperationError>[0]["code"],
  message: string,
  safeMessage = message,
  extra: Partial<ConstructorParameters<typeof ProviderOperationError>[0]> = {},
): ProviderOperationError {
  return new ProviderOperationError({
    code,
    message,
    safeMessage,
    retryable: code === "unavailable" || code === "rate_limited",
    uncertain: code === "unknown_outcome",
    providerId,
    module: "sandbox",
    operation,
    ...extra,
  });
}

function assertNotAborted(signal: AbortSignal, providerId: string, operation: string): void {
  if (signal.aborted)
    throw providerError(providerId, operation, "cancelled", "The sandbox operation was cancelled.");
}

function assertOperationBinding(
  binding: E2BBinding,
  context: ProviderOperationContext | undefined,
  providerId: string,
  operation: string,
): void {
  if (!context) return;
  if (
    (context.workspaceId !== undefined && context.workspaceId !== binding.workspaceId) ||
    (context.tenantId !== undefined && context.tenantId !== binding.tenantId) ||
    (context.userId !== undefined && context.userId !== binding.userId)
  )
    throw providerError(
      providerId,
      operation,
      "permission_denied",
      "The sandbox operation binding changed.",
      "The sandbox is not available in this scope.",
    );
}

function expectedMetadata(binding: E2BBinding): Record<string, string> {
  return {
    "openmuse.provider": binding.providerId,
    "openmuse.instance_id": binding.instanceId,
    "openmuse.workspace_id": binding.workspaceId,
    "openmuse.tenant_id": binding.tenantId ?? "",
    "openmuse.user_id": binding.userId ?? "",
  };
}

function assertOwned(
  info: E2BSandboxInfo,
  binding: E2BBinding,
  providerId: string,
  operation: string,
): void {
  const metadata = expectedMetadata(binding);
  for (const [key, value] of Object.entries(metadata)) {
    if (info.metadata[key] !== value)
      throw providerError(
        providerId,
        operation,
        "permission_denied",
        `E2B sandbox ownership metadata ${key} did not match.`,
        "The sandbox is not available in this scope.",
      );
  }
}

function safeWorkspacePath(value: string, providerId: string, operation: string): string {
  if (
    (!value.startsWith("/workspace/") && value !== "/workspace") ||
    value.includes("\\") ||
    value.includes("\0")
  )
    throw providerError(
      providerId,
      operation,
      "invalid_request",
      "Sandbox paths must stay below /workspace.",
      "The sandbox path is not allowed.",
    );
  const parts = value.split("/");
  if (
    parts.some((part, index) => part === "." || part === ".." || (index > 0 && part.length === 0))
  )
    throw providerError(
      providerId,
      operation,
      "invalid_request",
      "Sandbox paths cannot contain traversal or empty segments.",
      "The sandbox path is not allowed.",
    );
  return value;
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellCommand(argv: readonly string[]): string {
  if (argv.length === 0 || argv.some((value) => typeof value !== "string"))
    throw new Error("Sandbox argv must not be empty.");
  return argv.map(quoteShellArg).join(" ");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function mergeLimits(
  config: E2BConfig,
  request: SandboxCreateRequest,
  providerId: string,
): SandboxLimits {
  const unsupported = [
    ["cpu", request.cpu ?? request.limits?.cpu ?? config.maxLimits?.cpu],
    ["memoryMb", request.memoryMb ?? request.limits?.memoryMb ?? config.maxLimits?.memoryMb],
    ["diskMb", request.limits?.diskMb ?? config.maxLimits?.diskMb],
    ["pids", request.limits?.pids ?? config.maxLimits?.pids],
  ] as const;
  if (unsupported.some(([, value]) => value !== undefined))
    throw providerError(
      providerId,
      "create",
      "invalid_request",
      "E2B's official SDK does not expose requested CPU, memory, disk, or process limits.",
      "The requested sandbox limits are not supported.",
    );
  const timeoutSeconds =
    request.timeoutSeconds ??
    request.limits?.timeoutSeconds ??
    config.maxLimits?.timeoutSeconds ??
    60;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > config.maxSeconds
  )
    throw providerError(
      providerId,
      "create",
      "invalid_request",
      "Sandbox timeout exceeds the provider limit.",
    );
  return {
    ...defaultLimits,
    timeoutSeconds,
  };
}

function mapState(state: string | undefined): SandboxMetadata["status"] {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * Every E2B request receives a linked AbortSignal and request timeout. The
 * race remains necessary for adversarial/injected clients that ignore abort;
 * their eventual settlement is consumed to prevent unhandled rejections.
 */
function callWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<E2BOutcome<T>> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let didTimeout = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (settled) return;
      controller.abort(parent.reason);
      finish(() => resolve({ kind: didTimeout ? "timeout" : "aborted" }));
    };
    timer = setTimeout(() => {
      if (settled) return;
      didTimeout = true;
      controller.abort("E2B request deadline");
      finish(() => resolve({ kind: "timeout" }));
    }, timeoutMs);
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
    if (settled) return;
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve({ kind: "value", value })),
        (cause) => finish(() => reject(cause)),
      );
  });
}

async function killWithDeadline(sandbox: E2BSandbox, maxMs: number): Promise<boolean> {
  const outcome = await callWithDeadline(
    (signal) => sandbox.kill({ requestTimeoutMs: maxMs, signal }),
    new AbortController().signal,
    maxMs,
  ).catch(() => undefined);
  return outcome?.kind === "value";
}

function uncertain(
  providerId: string,
  operation: string,
  outcome: "timeout" | "aborted",
  message: string,
): ProviderOperationError {
  return providerError(
    providerId,
    operation,
    "unknown_outcome",
    message,
    "The sandbox operation outcome is unknown.",
    { details: { reason: outcome } },
  );
}

function commandResultFromError(error: unknown): E2BCommandResult | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as Partial<E2BCommandResult>;
  if (
    typeof candidate.exitCode !== "number" ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string"
  )
    return undefined;
  return {
    exitCode: candidate.exitCode,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
    ...(candidate.error ? { error: candidate.error } : {}),
  };
}

export function createE2BSandboxDriver(options: E2BSandboxDriverOptions = {}): SandboxDriver {
  const providerId = options.providerId ?? "sandbox-e2b";
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const displayName = options.displayName ?? "E2B sandbox";
  return {
    module: "sandbox",
    providerId,
    metadata: {
      providerId,
      displayName,
      version: "0.1.0",
      configVersion: "1",
      buildDigest: `builtin:${providerId}:0.1.0`,
      capabilities: [
        { key: "sandbox.create" },
        { key: "sandbox.reconnect" },
        { key: "sandbox.execute" },
        { key: "sandbox.files" },
        { key: "sandbox.cancel" },
      ],
      requiredSecrets: [
        { name: "apiKeySecret", description: "E2B API key reference", required: true },
      ],
      trusted: false,
    },
    config: {
      version: "1",
      schema: configSchema,
      secretReferences: (rawConfig) => [(rawConfig as E2BConfig).apiKeySecret],
      redact: (rawConfig) => {
        const config = rawConfig as E2BConfig;
        return {
          ...(config.endpoint ? { endpoint: config.endpoint } : {}),
          ...(config.domain ? { domain: config.domain } : {}),
          ...(config.template ? { template: config.template } : {}),
          ...(config.image ? { image: config.image } : {}),
          allowedTemplates: config.allowedTemplates,
          allowedImages: config.allowedImages,
        };
      },
    },
    async create(
      rawConfig: SandboxConfig,
      rawCreateContext: ProviderCreateContext,
    ): Promise<SandboxClient> {
      const config = configSchema.parse(rawConfig) as E2BConfig;
      const createContext = Object.freeze({ ...rawCreateContext });
      if (!options.factory)
        throw providerError(
          providerId,
          "configure",
          "unavailable",
          "An E2B SDK factory is required.",
        );
      if (!createContext.workspaceId)
        throw providerError(
          providerId,
          "configure",
          "invalid_request",
          "A workspace binding is required.",
        );
      const allowedTemplates = [...new Set([...config.allowedTemplates, ...config.allowedImages])];
      if (allowedTemplates.length === 0)
        throw providerError(
          providerId,
          "configure",
          "permission_denied",
          "E2B requires a non-empty template allowlist.",
          "The E2B provider is not configured.",
        );
      if (
        (config.template && !allowedTemplates.includes(config.template)) ||
        (config.image && !allowedTemplates.includes(config.image))
      )
        throw providerError(
          providerId,
          "configure",
          "permission_denied",
          "The configured E2B template is not allowlisted.",
          "The E2B provider is not configured.",
        );
      assertNotAborted(createContext.signal, providerId, "configure");
      if (!createContext.secrets)
        throw providerError(
          providerId,
          "authenticate",
          "authentication_required",
          "A secret resolver is required.",
          "The E2B provider is not configured.",
        );
      const apiKey = await createContext.secrets.resolve(config.apiKeySecret, createContext.signal);
      if (!apiKey)
        throw providerError(
          providerId,
          "authenticate",
          "authentication_required",
          "E2B API key is empty.",
          "The E2B provider is not configured.",
        );
      const sandboxClass = await options.factory.create({
        apiKey,
        ...(config.domain ? { domain: config.domain } : {}),
        ...(config.endpoint ? { apiUrl: config.endpoint } : {}),
      });
      const binding: E2BBinding = {
        providerId,
        instanceId,
        workspaceId: createContext.workspaceId,
        ...(createContext.tenantId ? { tenantId: createContext.tenantId } : {}),
        ...(createContext.userId ? { userId: createContext.userId } : {}),
      };
      const owned = new Map<string, E2BResource>();
      let closed = false;
      const ensureOpen = (operation: string) => {
        if (closed)
          throw providerError(providerId, operation, "failed", "The sandbox client is closed.");
      };

      const inspect = async (
        sandbox: E2BSandbox,
        context: ProviderOperationContext,
        operation: string,
      ): Promise<E2BSandboxInfo> => {
        assertOperationBinding(binding, context, providerId, operation);
        assertNotAborted(context.signal, providerId, operation);
        let outcome: E2BOutcome<E2BSandboxInfo>;
        try {
          outcome = await callWithDeadline(
            (signal) => sandbox.getInfo({ requestTimeoutMs: controlTimeoutMs, signal }),
            context.signal,
            controlTimeoutMs,
          );
        } catch (cause) {
          throw providerError(
            providerId,
            operation,
            "unavailable",
            cause instanceof Error ? cause.message : "E2B sandbox inspection failed.",
            "The sandbox could not be inspected.",
          );
        }
        if (outcome.kind === "aborted" && context.signal.aborted)
          throw providerError(
            providerId,
            operation,
            "cancelled",
            "The sandbox inspection was cancelled.",
          );
        if (outcome.kind !== "value")
          throw providerError(
            providerId,
            operation,
            "unavailable",
            "E2B sandbox inspection did not complete.",
            "The sandbox could not be inspected.",
            { details: { reason: outcome.kind } },
          );
        assertOwned(outcome.value, binding, providerId, operation);
        assertNotAborted(context.signal, providerId, operation);
        return outcome.value;
      };

      const resourceFor = (sandbox: E2BSandbox, info: E2BSandboxInfo, limits: SandboxLimits) =>
        new E2BResource(
          sandbox,
          metadataFor(info, binding, providerId, limits),
          binding,
          config.maxFileBytes,
          config.maxOutputBytes,
          config.maxSeconds,
          inspect,
          ensureOpen,
        );

      const reconnect = async (id: string, context: ProviderOperationContext): Promise<Sandbox> => {
        ensureOpen("reconnect");
        assertOperationBinding(binding, context, providerId, "reconnect");
        assertNotAborted(context.signal, providerId, "reconnect");
        if (!id.trim())
          throw providerError(
            providerId,
            "reconnect",
            "invalid_request",
            "Sandbox id is required.",
          );
        let info: E2BSandboxInfo;
        try {
          const infoOutcome = await callWithDeadline(
            (signal) => sandboxClass.getInfo(id, { requestTimeoutMs: controlTimeoutMs, signal }),
            context.signal,
            controlTimeoutMs,
          );
          if (infoOutcome.kind === "aborted" && context.signal.aborted)
            throw providerError(
              providerId,
              "reconnect",
              "cancelled",
              "The sandbox lookup was cancelled.",
            );
          if (infoOutcome.kind !== "value")
            throw providerError(
              providerId,
              "reconnect",
              "not_found",
              "E2B sandbox lookup did not complete.",
              "The sandbox was not found.",
            );
          info = infoOutcome.value;
          assertOwned(info, binding, providerId, "reconnect");
        } catch (cause) {
          if (cause instanceof ProviderOperationError) throw cause;
          throw providerError(
            providerId,
            "reconnect",
            "not_found",
            cause instanceof Error ? cause.message : "E2B sandbox was not found.",
            "The sandbox was not found.",
          );
        }
        let sandbox: E2BSandbox;
        try {
          const connected = await callWithDeadline(
            (signal) => sandboxClass.connect(id, { requestTimeoutMs: controlTimeoutMs, signal }),
            context.signal,
            controlTimeoutMs,
          );
          if (connected.kind === "aborted" && context.signal.aborted)
            throw providerError(
              providerId,
              "reconnect",
              "cancelled",
              "The sandbox connection was cancelled.",
            );
          if (connected.kind !== "value")
            throw providerError(
              providerId,
              "reconnect",
              "not_found",
              "E2B sandbox connection did not complete.",
              "The sandbox was not found.",
            );
          sandbox = connected.value;
          info = await inspect(sandbox, context, "reconnect");
        } catch (cause) {
          if (cause instanceof ProviderOperationError) throw cause;
          throw providerError(
            providerId,
            "reconnect",
            "not_found",
            cause instanceof Error ? cause.message : "E2B sandbox was not found.",
            "The sandbox was not found.",
          );
        }
        const limits: SandboxLimits = {
          ...defaultLimits,
          ...config.maxLimits,
          cpu: info.cpuCount ?? defaultLimits.cpu,
          memoryMb: info.memoryMB ?? defaultLimits.memoryMb,
          timeoutSeconds: Math.min(config.maxSeconds, config.maxLimits?.timeoutSeconds ?? 60),
        };
        const resource = resourceFor(sandbox, info, limits);
        owned.set(resource.id, resource);
        return resource;
      };

      return {
        async create(
          request: SandboxCreateRequest,
          context: ProviderOperationContext,
        ): Promise<Sandbox> {
          ensureOpen("create");
          assertOperationBinding(binding, context, providerId, "create");
          assertNotAborted(context.signal, providerId, "create");
          if (request.workspaceId !== undefined && request.workspaceId !== binding.workspaceId)
            throw providerError(
              providerId,
              "create",
              "permission_denied",
              "Sandbox workspace binding changed.",
              "The sandbox is not available in this workspace.",
            );
          const template = request.image ?? config.template ?? config.image;
          if (!template)
            throw providerError(
              providerId,
              "create",
              "invalid_request",
              "An E2B template is required.",
            );
          if (!allowedTemplates.includes(template))
            throw providerError(
              providerId,
              "create",
              "permission_denied",
              "The requested E2B template is not allowlisted.",
              "The sandbox image is not allowed.",
            );
          const limits = mergeLimits(config, request, providerId);
          const timeoutMs = (limits.timeoutSeconds ?? 60) * 1000;
          let sandbox: E2BSandbox | undefined;
          try {
            const created = await callWithDeadline(
              (signal) =>
                sandboxClass.create(template, {
                  metadata: expectedMetadata(binding),
                  timeoutMs,
                  requestTimeoutMs: Math.min(controlTimeoutMs, timeoutMs),
                  signal,
                }),
              context.signal,
              timeoutMs,
            );
            if (created.kind !== "value")
              throw uncertain(
                providerId,
                "create",
                created.kind,
                "E2B sandbox creation did not complete.",
              );
            sandbox = created.value;
            const info = await inspect(sandbox, context, "create");
            const resource = resourceFor(sandbox, info, limits);
            owned.set(resource.id, resource);
            return resource;
          } catch (cause) {
            if (sandbox) {
              const deleted = await killWithDeadline(sandbox, controlTimeoutMs);
              if (!deleted)
                throw providerError(
                  providerId,
                  "create",
                  "unknown_outcome",
                  "E2B sandbox creation failed and cleanup could not be verified.",
                  "The sandbox creation cleanup outcome is unknown.",
                );
            }
            if (cause instanceof ProviderOperationError) throw cause;
            if (context.signal.aborted)
              throw providerError(
                providerId,
                "create",
                "cancelled",
                "The sandbox creation was cancelled.",
              );
            throw providerError(
              providerId,
              "create",
              "failed",
              cause instanceof Error ? cause.message : "E2B sandbox creation failed.",
              "The sandbox could not be created.",
            );
          }
        },
        get: reconnect,
        reconnect,
        async destroy(id: string, context: ProviderOperationContext): Promise<void> {
          const resource = await reconnect(id, context);
          await resource.destroy(context);
          owned.delete(id);
        },
        async close(reason?: string): Promise<void> {
          if (closed) return;
          closed = true;
          const failures: unknown[] = [];
          for (const resource of owned.values()) {
            try {
              await resource.destroy(undefined, reason ?? "client closed");
            } catch (cause) {
              failures.push(cause);
            }
          }
          owned.clear();
          if (failures.length > 0)
            throw providerError(
              providerId,
              "close",
              "unknown_outcome",
              `Failed to destroy ${failures.length} E2B sandbox resource(s).`,
              "The sandbox cleanup outcome is unknown.",
              { details: { failureCount: failures.length } },
            );
        },
      };
    },
  };
}

function metadataFor(
  info: E2BSandboxInfo,
  binding: E2BBinding,
  providerId: string,
  limits: SandboxLimits,
): SandboxMetadata {
  return {
    id: info.sandboxId,
    providerId,
    workspaceId: binding.workspaceId,
    image: info.templateId,
    status: mapState(info.state),
    ...(info.startedAt ? { createdAt: info.startedAt.toISOString() } : {}),
    ...(info.endAt ? { expiresAt: info.endAt.toISOString() } : {}),
    limits,
  };
}

class E2BResource implements Sandbox {
  readonly id: string;
  readonly metadata: SandboxMetadata;
  private destroyed = false;

  constructor(
    private readonly sandbox: E2BSandbox,
    metadata: SandboxMetadata,
    private readonly binding: E2BBinding,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
    private readonly maxSeconds: number,
    private readonly inspect: (
      sandbox: E2BSandbox,
      context: ProviderOperationContext,
      operation: string,
    ) => Promise<E2BSandboxInfo>,
    private readonly ensureOpen: (operation: string) => void,
  ) {
    this.id = sandbox.sandboxId;
    this.metadata = metadata;
  }

  async exec(
    request: SandboxExecRequest,
    context: ProviderOperationContext,
  ): Promise<SandboxExecResult> {
    return this.execute(request, context);
  }

  async execute(
    request: SandboxExecRequest,
    context: ProviderOperationContext,
  ): Promise<SandboxExecResult> {
    this.ensureUsable("execute");
    assertOperationBinding(this.binding, context, this.binding.providerId, "execute");
    assertNotAborted(context.signal, this.binding.providerId, "execute");
    await this.inspect(this.sandbox, context, "execute");
    if (request.argv.length === 0 || request.argv.some((value) => typeof value !== "string"))
      throw providerError(
        this.binding.providerId,
        "execute",
        "invalid_request",
        "Sandbox argv must not be empty.",
      );
    if (request.cwd) safeWorkspacePath(request.cwd, this.binding.providerId, "execute");
    const timeoutSeconds = request.timeoutSeconds ?? this.metadata.limits.timeoutSeconds ?? 60;
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      timeoutSeconds > this.maxSeconds ||
      timeoutSeconds > (this.metadata.limits.timeoutSeconds ?? timeoutSeconds)
    )
      throw providerError(
        this.binding.providerId,
        "execute",
        "invalid_request",
        "Sandbox command timeout exceeds its limit.",
      );
    let handle: E2BCommandHandle | undefined;
    let outputBytes = 0;
    let outputExceeded = false;
    let killPromise: Promise<boolean> | undefined;
    let killFailure: unknown;
    const onOutput = (chunk: string) => {
      outputBytes += byteLength(chunk);
      if (outputBytes <= this.maxOutputBytes || killPromise) return;
      outputExceeded = true;
      if (handle) {
        killPromise = handle.kill().catch((cause) => {
          killFailure = cause;
          return false;
        });
      }
    };
    let started: E2BOutcome<E2BCommandHandle>;
    try {
      started = await callWithDeadline(
        (signal) =>
          this.sandbox.commands.run(shellCommand(request.argv), {
            background: true,
            ...(request.cwd ? { cwd: request.cwd } : {}),
            ...(request.env ? { envs: request.env } : {}),
            timeoutMs: timeoutSeconds * 1000,
            requestTimeoutMs: controlTimeoutMs,
            signal,
            onStdout: onOutput,
            onStderr: onOutput,
          }),
        context.signal,
        Math.min(timeoutSeconds * 1000, controlTimeoutMs),
      );
    } catch (cause) {
      throw providerError(
        this.binding.providerId,
        "execute",
        "failed",
        cause instanceof Error ? cause.message : "E2B command start failed.",
        "The sandbox command failed.",
      );
    }
    if (started.kind !== "value") {
      const deleted = await killWithDeadline(this.sandbox, controlTimeoutMs);
      if (deleted) {
        this.destroyed = true;
        markDestroyed(this.metadata);
        if (started.kind === "aborted")
          throw providerError(
            this.binding.providerId,
            "execute",
            "cancelled",
            "The sandbox command was cancelled.",
          );
        return {
          exitCode: 124,
          stdout: "",
          stderr: "Sandbox command timed out.",
          timedOut: true,
          providerOperationId: context.operationId,
        };
      }
      throw uncertain(
        this.binding.providerId,
        "execute",
        started.kind,
        "E2B command start cancellation could not be verified.",
      );
    }
    handle = started.value;
    if (outputExceeded && !killPromise) {
      killPromise = handle.kill().catch((cause) => {
        killFailure = cause;
        return false;
      });
    }
    let waited: E2BOutcome<E2BCommandResult>;
    try {
      waited = await callWithDeadline(
        () =>
          handle!.wait().catch((cause) => {
            const result = commandResultFromError(cause);
            if (result) return result;
            throw cause;
          }),
        context.signal,
        timeoutSeconds * 1000,
      );
    } catch (cause) {
      throw providerError(
        this.binding.providerId,
        "execute",
        "failed",
        cause instanceof Error ? cause.message : "E2B command failed.",
        "The sandbox command failed.",
      );
    }
    if (waited.kind !== "value") {
      try {
        const killed = await callWithDeadline(
          () => handle!.kill(),
          new AbortController().signal,
          controlTimeoutMs,
        );
        if (killed.kind !== "value")
          throw uncertain(
            this.binding.providerId,
            "execute",
            killed.kind,
            "E2B command cancellation could not be verified.",
          );
      } catch (cause) {
        if (cause instanceof ProviderOperationError) throw cause;
        throw providerError(
          this.binding.providerId,
          "execute",
          "unknown_outcome",
          cause instanceof Error ? cause.message : "E2B command cancellation failed.",
          "The sandbox command outcome is unknown.",
        );
      }
      if (waited.kind === "aborted")
        throw providerError(
          this.binding.providerId,
          "execute",
          "cancelled",
          "The sandbox command was cancelled.",
        );
      return {
        exitCode: 124,
        stdout: "",
        stderr: "Sandbox command timed out.",
        timedOut: true,
        providerOperationId: context.operationId,
      };
    }
    if (killPromise) await killPromise;
    if (killFailure)
      throw providerError(
        this.binding.providerId,
        "execute",
        "unknown_outcome",
        killFailure instanceof Error
          ? killFailure.message
          : "E2B output-limit cancellation failed.",
        "The sandbox command outcome is unknown.",
      );
    const stdout = waited.value.stdout ?? handle.stdout ?? "";
    const stderr = waited.value.stderr ?? handle.stderr ?? "";
    if (outputExceeded || byteLength(stdout) + byteLength(stderr) > this.maxOutputBytes)
      throw providerError(
        this.binding.providerId,
        "execute",
        "failed",
        "E2B sandbox output exceeded its limit.",
        "The sandbox produced too much output.",
      );
    return {
      exitCode: waited.value.exitCode,
      stdout,
      stderr,
      timedOut: false,
      providerOperationId: context.operationId,
    };
  }

  async readFile(filePath: string, context: ProviderOperationContext): Promise<Uint8Array> {
    this.ensureUsable("readFile");
    assertOperationBinding(this.binding, context, this.binding.providerId, "readFile");
    assertNotAborted(context.signal, this.binding.providerId, "readFile");
    await this.inspect(this.sandbox, context, "readFile");
    const path = safeWorkspacePath(filePath, this.binding.providerId, "readFile");
    await this.assertNotSymlink(path, context, "readFile");
    try {
      const outcome = await callWithDeadline(
        (signal) =>
          this.sandbox.files.read(path, {
            format: "bytes",
            requestTimeoutMs: controlTimeoutMs,
            signal,
          }),
        context.signal,
        controlTimeoutMs,
      );
      if (outcome.kind === "aborted" && context.signal.aborted)
        throw providerError(
          this.binding.providerId,
          "readFile",
          "cancelled",
          "The sandbox file read was cancelled.",
        );
      if (outcome.kind !== "value")
        throw uncertain(
          this.binding.providerId,
          "readFile",
          outcome.kind,
          "E2B file read did not complete.",
        );
      if (outcome.value.byteLength > this.maxFileBytes)
        throw providerError(
          this.binding.providerId,
          "readFile",
          "failed",
          "E2B file exceeded its limit.",
          "The sandbox file is too large.",
        );
      return new Uint8Array(outcome.value);
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      if (context.signal.aborted)
        throw providerError(
          this.binding.providerId,
          "readFile",
          "cancelled",
          "The sandbox file read was cancelled.",
        );
      throw providerError(
        this.binding.providerId,
        "readFile",
        "failed",
        cause instanceof Error ? cause.message : "E2B file read failed.",
        "The sandbox file could not be read.",
      );
    }
  }

  async writeFile(file: SandboxFile, context: ProviderOperationContext): Promise<void> {
    this.ensureUsable("writeFile");
    assertOperationBinding(this.binding, context, this.binding.providerId, "writeFile");
    assertNotAborted(context.signal, this.binding.providerId, "writeFile");
    await this.inspect(this.sandbox, context, "writeFile");
    const path = safeWorkspacePath(file.path, this.binding.providerId, "writeFile");
    await this.assertNotSymlink(path, context, "writeFile", true);
    const bytes = new Uint8Array(file.bytes);
    if (bytes.byteLength > this.maxFileBytes)
      throw providerError(
        this.binding.providerId,
        "writeFile",
        "invalid_request",
        "E2B file exceeded its limit.",
        "The sandbox file is too large.",
      );
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    try {
      const outcome = await callWithDeadline(
        (signal) =>
          this.sandbox.files.write(path, arrayBuffer, {
            requestTimeoutMs: controlTimeoutMs,
            signal,
          }),
        context.signal,
        controlTimeoutMs,
      );
      if (outcome.kind !== "value")
        throw uncertain(
          this.binding.providerId,
          "writeFile",
          outcome.kind,
          "E2B file write could not be verified.",
        );
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      throw providerError(
        this.binding.providerId,
        "writeFile",
        "failed",
        cause instanceof Error ? cause.message : "E2B file write failed.",
        "The sandbox file could not be written.",
      );
    }
  }

  async destroy(context?: ProviderOperationContext, reason = "sandbox destroyed"): Promise<void> {
    if (this.destroyed) return;
    const signal = context?.signal ?? new AbortController().signal;
    if (context) {
      assertOperationBinding(this.binding, context, this.binding.providerId, "destroy");
      assertNotAborted(signal, this.binding.providerId, "destroy");
      await this.inspect(this.sandbox, context, "destroy");
    } else {
      await this.inspect(
        this.sandbox,
        {
          signal,
          operationId: `shutdown-${this.id}`,
          workspaceId: this.binding.workspaceId,
          ...(this.binding.tenantId ? { tenantId: this.binding.tenantId } : {}),
          ...(this.binding.userId ? { userId: this.binding.userId } : {}),
        },
        "destroy",
      );
    }
    void reason;
    try {
      const outcome = await callWithDeadline(
        (killSignal) =>
          this.sandbox.kill({ requestTimeoutMs: controlTimeoutMs, signal: killSignal }),
        signal,
        controlTimeoutMs,
      );
      if (outcome.kind !== "value")
        throw uncertain(
          this.binding.providerId,
          "destroy",
          outcome.kind,
          "E2B sandbox cleanup could not be verified.",
        );
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      throw providerError(
        this.binding.providerId,
        "destroy",
        "unknown_outcome",
        cause instanceof Error ? cause.message : "E2B sandbox cleanup failed.",
        "The sandbox cleanup outcome is unknown.",
      );
    }
    this.destroyed = true;
    markDestroyed(this.metadata);
  }

  async close(reason?: string): Promise<void> {
    await this.destroy(undefined, reason ?? "sandbox closed");
  }

  private async assertNotSymlink(
    path: string,
    context: ProviderOperationContext,
    operation: string,
    allowMissing = false,
  ): Promise<void> {
    if (!this.sandbox.files.getInfo) return;
    try {
      const outcome = await callWithDeadline(
        (signal) =>
          this.sandbox.files.getInfo!(path, {
            requestTimeoutMs: controlTimeoutMs,
            signal,
          }),
        context.signal,
        controlTimeoutMs,
      );
      if (outcome.kind !== "value")
        throw uncertain(
          this.binding.providerId,
          operation,
          outcome.kind,
          "E2B file inspection did not complete.",
        );
      if (outcome.value.type === "symlink" || outcome.value.symlinkTarget !== undefined)
        throw providerError(
          this.binding.providerId,
          operation,
          "permission_denied",
          "E2B file operations do not follow symlinks.",
          "The sandbox path is not allowed.",
        );
    } catch (cause) {
      if (allowMissing && isNotFound(cause)) return;
      throw cause;
    }
  }

  private ensureUsable(operation: string): void {
    this.ensureOpen(operation);
    if (this.destroyed)
      throw providerError(
        this.binding.providerId,
        operation,
        "failed",
        "The E2B sandbox resource has already been destroyed.",
        "The sandbox is no longer available.",
      );
  }
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof Error && /not found|404/i.test(error.message)) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "not_found")
  );
}

function markDestroyed(metadata: SandboxMetadata): void {
  metadata.status = "destroyed";
}

export { configSchema as e2bSandboxConfigSchema };
