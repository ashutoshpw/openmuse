import { z } from "zod";
import type { Daytona as OfficialDaytonaSdk } from "@daytonaio/sdk";
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

/**
 * The official @daytonaio/sdk API is kept behind this small structural
 * boundary. It lets tests inject an adversarial SDK while production can pass
 * the actual Daytona constructor without reading credentials at import time.
 */
export interface DaytonaSandbox {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state?: string;
  readonly snapshot?: string;
  readonly createdAt?: string;
  readonly autoDestroyAt?: string;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
  readonly process: DaytonaProcess;
  readonly fs: DaytonaFileSystem;
  refreshData(): Promise<void>;
  /** timeout and SDK request timeout are seconds in the official SDK. */
  delete(timeout?: number, wait?: boolean): Promise<void>;
}

export interface DaytonaProcess {
  executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecuteResponse>;
}

export interface DaytonaFileSystem {
  downloadFile(remotePath: string, timeout?: number): Promise<Uint8Array>;
  uploadFile(file: Uint8Array, remotePath: string, timeout?: number): Promise<void>;
}

/** Shape returned by Sandbox.process.executeCommand in the official SDK. */
export interface DaytonaExecuteResponse {
  exitCode: number;
  result: string;
  artifacts?: { stdout?: string };
}

export interface DaytonaSdkClient {
  create(params: DaytonaCreateParams, options?: { timeout?: number }): Promise<DaytonaSandbox>;
  get(idOrName: string): Promise<DaytonaSandbox>;
}

export interface DaytonaSdkFactory {
  create(options: {
    apiKey: string;
    apiUrl?: string;
    target?: string;
    requestTimeoutMs?: number;
  }): Promise<DaytonaSdkClient>;
}

/** Parameters supported by Daytona.create in @daytonaio/sdk 0.215.0. */
export interface DaytonaCreateParams {
  snapshot?: string;
  image?: string;
  labels: Record<string, string>;
  resources?: {
    cpu?: number;
    memory?: number;
    disk?: number;
  };
  ttlMinutes?: number;
  envVars?: Record<string, string>;
}

export interface OfficialDaytonaConstructor {
  new (config: OfficialDaytonaSdkConfig): DaytonaSdkClient;
}

/** Constructor options verified against the pinned official SDK. */
export type OfficialDaytonaSdkConfig = ConstructorParameters<typeof OfficialDaytonaSdk>[0];

export function createOfficialDaytonaFactory(
  Daytona: OfficialDaytonaConstructor,
): DaytonaSdkFactory {
  return {
    async create(options) {
      return new Daytona(options);
    },
  };
}

export interface DaytonaSandboxDriverOptions {
  factory?: DaytonaSdkFactory;
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
    endpoint: z.string().url().default("https://app.daytona.io/api"),
    apiKeySecret: z.string().trim().min(1),
    target: z.string().trim().min(1).optional(),
    snapshot: z.string().trim().min(1).optional(),
    /** Alias matching the shared SandboxConfig vocabulary. */
    image: z.string().trim().min(1).optional(),
    /** Empty allowlists are intentionally rejected by create(). */
    allowedSnapshots: z.array(z.string().trim().min(1)).max(100).default([]),
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

const controlTimeoutSeconds = 30;

interface DaytonaConfig extends SandboxConfig {
  endpoint: string;
  apiKeySecret: string;
  target?: string;
  snapshot?: string;
  image?: string;
  allowedSnapshots: string[];
  maxSeconds: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

interface DaytonaBinding {
  providerId: string;
  instanceId: string;
  workspaceId: string;
  tenantId?: string;
  userId?: string;
}

type DaytonaOperationOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" };

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
  binding: DaytonaBinding,
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

function expectedLabels(binding: DaytonaBinding): Record<string, string> {
  return {
    "openmuse.provider": binding.providerId,
    "openmuse.instance_id": binding.instanceId,
    "openmuse.workspace_id": binding.workspaceId,
    "openmuse.tenant_id": binding.tenantId ?? "",
    "openmuse.user_id": binding.userId ?? "",
  };
}

function assertOwned(
  sandbox: DaytonaSandbox,
  binding: DaytonaBinding,
  providerId: string,
  operation: string,
): void {
  const labels = expectedLabels(binding);
  for (const [key, value] of Object.entries(labels)) {
    if (sandbox.labels[key] !== value)
      throw providerError(
        providerId,
        operation,
        "permission_denied",
        `Daytona sandbox ownership label ${key} did not match.`,
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

function mergeLimits(
  config: DaytonaConfig,
  request: SandboxCreateRequest,
  providerId: string,
): SandboxLimits {
  if (request.limits?.pids !== undefined || config.maxLimits?.pids !== undefined)
    throw providerError(
      providerId,
      "create",
      "invalid_request",
      "Daytona's official SDK does not expose a process-count limit.",
      "The requested sandbox limits are not supported.",
    );
  const merged: SandboxLimits = {
    ...defaultLimits,
    ...config.maxLimits,
    ...request.limits,
    ...(request.cpu === undefined ? {} : { cpu: request.cpu }),
    ...(request.memoryMb === undefined ? {} : { memoryMb: request.memoryMb }),
    ...(request.timeoutSeconds === undefined ? {} : { timeoutSeconds: request.timeoutSeconds }),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || !Number.isFinite(value) || value <= 0)
      throw providerError(providerId, "create", "invalid_request", `Invalid sandbox limit ${key}.`);
    const ceiling = config.maxLimits?.[key as keyof SandboxLimits];
    if (ceiling !== undefined && value > ceiling)
      throw providerError(
        providerId,
        "create",
        "invalid_request",
        `Sandbox limit ${key} exceeds the configured ceiling.`,
      );
  }
  if ((merged.timeoutSeconds ?? defaultLimits.timeoutSeconds) > config.maxSeconds)
    throw providerError(
      providerId,
      "create",
      "invalid_request",
      "Sandbox timeout exceeds the provider limit.",
    );
  return merged;
}

function mapState(state: string | undefined): SandboxMetadata["status"] {
  switch (state) {
    case "started":
    case "starting":
    case "running":
      return "running";
    case "stopped":
    case "stopping":
    case "paused":
      return "stopped";
    case "destroyed":
    case "deleting":
      return "destroyed";
    default:
      return "unknown";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * SDK methods in Daytona 0.215.0 do not accept AbortSignal. This race gives
 * callers a hard local deadline and consumes the eventual SDK settlement so a
 * late rejection cannot become unhandled. A raced mutation is always treated
 * as uncertain unless the whole sandbox is successfully deleted.
 */
function raceSdk<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  seconds: number,
): Promise<DaytonaOperationOutcome<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ kind: "timeout" });
    }, seconds * 1000);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "value", value });
      },
      (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function deleteWithDeadline(sandbox: DaytonaSandbox, maxSeconds: number): Promise<boolean> {
  const signal = new AbortController().signal;
  const timeoutSeconds = Math.min(maxSeconds, controlTimeoutSeconds);
  try {
    const outcome = await raceSdk(sandbox.delete(timeoutSeconds, true), signal, timeoutSeconds);
    return outcome.kind === "value";
  } catch {
    return false;
  }
}

function markDestroyed(metadata: SandboxMetadata): void {
  metadata.status = "destroyed";
}

function operationFailure(
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

export function createDaytonaSandboxDriver(
  options: DaytonaSandboxDriverOptions = {},
): SandboxDriver {
  const providerId = options.providerId ?? "sandbox-daytona";
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const displayName = options.displayName ?? "Daytona sandbox";
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
        { name: "apiKeySecret", description: "Daytona API key reference", required: true },
      ],
      trusted: false,
    },
    config: {
      version: "1",
      schema: configSchema,
      secretReferences: (rawConfig) => [(rawConfig as DaytonaConfig).apiKeySecret],
      redact: (rawConfig) => {
        const config = rawConfig as DaytonaConfig;
        return {
          endpoint: config.endpoint,
          ...(config.target ? { target: config.target } : {}),
          ...(config.snapshot ? { snapshot: config.snapshot } : {}),
          ...(config.image ? { image: config.image } : {}),
          allowedSnapshots: config.allowedSnapshots,
        };
      },
    },
    async create(
      rawConfig: SandboxConfig,
      rawCreateContext: ProviderCreateContext,
    ): Promise<SandboxClient> {
      const config = configSchema.parse(rawConfig) as DaytonaConfig;
      const createContext = Object.freeze({ ...rawCreateContext });
      if (!options.factory)
        throw providerError(
          providerId,
          "configure",
          "unavailable",
          "A Daytona SDK factory is required.",
        );
      if (!createContext.workspaceId)
        throw providerError(
          providerId,
          "configure",
          "invalid_request",
          "A workspace binding is required.",
        );
      if (config.allowedSnapshots.length === 0)
        throw providerError(
          providerId,
          "configure",
          "permission_denied",
          "Daytona requires a non-empty snapshot allowlist.",
          "The Daytona provider is not configured.",
        );
      if (
        (config.snapshot && !config.allowedSnapshots.includes(config.snapshot)) ||
        (config.image && !config.allowedSnapshots.includes(config.image))
      )
        throw providerError(
          providerId,
          "configure",
          "permission_denied",
          "The configured Daytona snapshot is not allowlisted.",
          "The Daytona provider is not configured.",
        );
      assertNotAborted(createContext.signal, providerId, "configure");
      if (!createContext.secrets)
        throw providerError(
          providerId,
          "authenticate",
          "authentication_required",
          "A secret resolver is required.",
          "The Daytona provider is not configured.",
        );
      const apiKey = await createContext.secrets.resolve(config.apiKeySecret, createContext.signal);
      if (!apiKey)
        throw providerError(
          providerId,
          "authenticate",
          "authentication_required",
          "Daytona API key is empty.",
          "The Daytona provider is not configured.",
        );
      const sdk = await options.factory.create({
        apiKey,
        apiUrl: config.endpoint,
        ...(config.target ? { target: config.target } : {}),
        requestTimeoutMs: controlTimeoutSeconds * 1000,
      });
      const binding: DaytonaBinding = {
        providerId,
        instanceId,
        workspaceId: createContext.workspaceId,
        ...(createContext.tenantId ? { tenantId: createContext.tenantId } : {}),
        ...(createContext.userId ? { userId: createContext.userId } : {}),
      };
      const owned = new Map<string, DaytonaResource>();
      let closed = false;
      const ensureOpen = (operation: string) => {
        if (closed)
          throw providerError(providerId, operation, "failed", "The sandbox client is closed.");
      };

      const inspect = async (
        sandbox: DaytonaSandbox,
        context: ProviderOperationContext,
        operation: string,
      ): Promise<void> => {
        assertOperationBinding(binding, context, providerId, operation);
        assertNotAborted(context.signal, providerId, operation);
        let refreshed: DaytonaOperationOutcome<void>;
        try {
          refreshed = await raceSdk(sandbox.refreshData(), context.signal, controlTimeoutSeconds);
        } catch (cause) {
          throw providerError(
            providerId,
            operation,
            "unavailable",
            cause instanceof Error ? cause.message : "Daytona sandbox inspection failed.",
            "The sandbox could not be inspected.",
          );
        }
        if (refreshed.kind === "aborted" && context.signal.aborted)
          throw providerError(
            providerId,
            operation,
            "cancelled",
            "The sandbox inspection was cancelled.",
          );
        if (refreshed.kind !== "value")
          throw providerError(
            providerId,
            operation,
            "unavailable",
            "Daytona sandbox inspection did not complete.",
            "The sandbox could not be inspected.",
            { details: { reason: refreshed.kind } },
          );
        assertOwned(sandbox, binding, providerId, operation);
        assertNotAborted(context.signal, providerId, operation);
      };

      const resourceFor = (sandbox: DaytonaSandbox, limits: SandboxLimits): DaytonaResource => {
        const metadata: SandboxMetadata = {
          id: sandbox.id,
          providerId,
          workspaceId: binding.workspaceId,
          ...(sandbox.snapshot ? { image: sandbox.snapshot } : {}),
          status: mapState(sandbox.state),
          ...(sandbox.createdAt ? { createdAt: sandbox.createdAt } : {}),
          ...(sandbox.autoDestroyAt ? { expiresAt: sandbox.autoDestroyAt } : {}),
          limits,
        };
        return new DaytonaResource(
          sandbox,
          metadata,
          binding,
          config.maxFileBytes,
          config.maxOutputBytes,
          config.maxSeconds,
          inspect,
          ensureOpen,
        );
      };

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
        let sandbox: DaytonaSandbox;
        try {
          const outcome = await raceSdk(sdk.get(id), context.signal, controlTimeoutSeconds);
          if (outcome.kind === "aborted" && context.signal.aborted)
            throw providerError(
              providerId,
              "reconnect",
              "cancelled",
              "The sandbox lookup was cancelled.",
            );
          if (outcome.kind !== "value")
            throw providerError(
              providerId,
              "reconnect",
              "not_found",
              "Daytona sandbox lookup did not complete.",
              "The sandbox was not found.",
            );
          sandbox = outcome.value;
          await inspect(sandbox, context, "reconnect");
        } catch (cause) {
          if (cause instanceof ProviderOperationError) throw cause;
          throw providerError(
            providerId,
            "reconnect",
            "not_found",
            cause instanceof Error ? cause.message : "Daytona sandbox was not found.",
            "The sandbox was not found.",
          );
        }
        const limits: SandboxLimits = {
          ...defaultLimits,
          ...config.maxLimits,
          cpu: sandbox.cpu,
          memoryMb: Math.round(sandbox.memory * 1024),
          diskMb: Math.round(sandbox.disk * 1024),
          timeoutSeconds: Math.min(config.maxSeconds, config.maxLimits?.timeoutSeconds ?? 60),
        };
        const resource = resourceFor(sandbox, limits);
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
          const limits = mergeLimits(config, request, providerId);
          const selectedImage = config.snapshot ?? config.image ?? request.image;
          if (!selectedImage)
            throw providerError(
              providerId,
              "create",
              "invalid_request",
              "A Daytona snapshot or image is required.",
            );
          if (!config.allowedSnapshots.includes(selectedImage))
            throw providerError(
              providerId,
              "create",
              "permission_denied",
              "The requested Daytona snapshot is not allowlisted.",
              "The sandbox image is not allowed.",
            );
          const requestTimeout = Math.min(
            config.maxSeconds,
            limits.timeoutSeconds ?? defaultLimits.timeoutSeconds,
          );
          let sandbox: DaytonaSandbox | undefined;
          try {
            const created = await raceSdk(
              sdk.create(
                {
                  ...(config.snapshot ? { snapshot: config.snapshot } : { image: selectedImage }),
                  labels: expectedLabels(binding),
                  resources: {
                    cpu: limits.cpu,
                    memory: (limits.memoryMb ?? defaultLimits.memoryMb) / 1024,
                    disk: (limits.diskMb ?? defaultLimits.diskMb) / 1024,
                  },
                  ttlMinutes: Math.max(1, Math.ceil(requestTimeout / 60)),
                },
                { timeout: requestTimeout },
              ),
              context.signal,
              requestTimeout,
            );
            if (created.kind !== "value")
              throw operationFailure(
                providerId,
                "create",
                created.kind,
                "Daytona sandbox creation did not complete.",
              );
            sandbox = created.value;
            await inspect(sandbox, context, "create");
          } catch (cause) {
            if (sandbox) {
              const deleted = await deleteWithDeadline(sandbox, config.maxSeconds);
              if (!deleted)
                throw providerError(
                  providerId,
                  "create",
                  "unknown_outcome",
                  "Daytona sandbox creation failed and cleanup could not be verified.",
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
              cause instanceof Error ? cause.message : "Daytona sandbox creation failed.",
              "The sandbox could not be created.",
            );
          }
          const resource = resourceFor(sandbox, limits);
          owned.set(resource.id, resource);
          return resource;
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
              `Failed to destroy ${failures.length} Daytona sandbox resource(s).`,
              "The sandbox cleanup outcome is unknown.",
              { details: { failureCount: failures.length } },
            );
        },
      };
    },
  };
}

class DaytonaResource implements Sandbox {
  readonly id: string;
  readonly metadata: SandboxMetadata;
  private destroyed = false;

  constructor(
    private readonly sandbox: DaytonaSandbox,
    metadata: SandboxMetadata,
    private readonly binding: DaytonaBinding,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
    private readonly maxSeconds: number,
    private readonly inspect: (
      sandbox: DaytonaSandbox,
      context: ProviderOperationContext,
      operation: string,
    ) => Promise<void>,
    private readonly ensureOpen: (operation: string) => void,
  ) {
    this.id = sandbox.id;
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
      !Number.isFinite(timeoutSeconds) ||
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
    let outcome: DaytonaOperationOutcome<DaytonaExecuteResponse>;
    try {
      outcome = await raceSdk(
        this.sandbox.process.executeCommand(
          shellCommand(request.argv),
          request.cwd,
          request.env,
          timeoutSeconds,
        ),
        context.signal,
        timeoutSeconds,
      );
    } catch (cause) {
      throw providerError(
        this.binding.providerId,
        "execute",
        "failed",
        cause instanceof Error ? cause.message : "Daytona sandbox command failed.",
        "The sandbox command failed.",
      );
    }
    if (outcome.kind !== "value") {
      const deleted = await deleteWithDeadline(this.sandbox, this.maxSeconds);
      if (deleted) {
        this.destroyed = true;
        markDestroyed(this.metadata);
        if (outcome.kind === "timeout")
          return {
            exitCode: 124,
            stdout: "",
            stderr: "Sandbox command timed out.",
            timedOut: true,
            providerOperationId: context.operationId,
          };
        throw providerError(
          this.binding.providerId,
          "execute",
          "cancelled",
          "The sandbox command was cancelled.",
        );
      }
      throw operationFailure(
        this.binding.providerId,
        "execute",
        outcome.kind,
        "Daytona command cancellation could not be verified.",
      );
    }
    const stdout = outcome.value.artifacts?.stdout ?? outcome.value.result;
    if (byteLength(stdout) > this.maxOutputBytes)
      throw providerError(
        this.binding.providerId,
        "execute",
        "failed",
        "Daytona sandbox output exceeded its limit.",
        "The sandbox produced too much output.",
      );
    return {
      exitCode: outcome.value.exitCode,
      stdout,
      stderr: "",
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
    try {
      const outcome = await raceSdk(
        this.sandbox.fs.downloadFile(path, controlTimeoutSeconds),
        context.signal,
        controlTimeoutSeconds,
      );
      if (outcome.kind !== "value")
        throw operationFailure(
          this.binding.providerId,
          "readFile",
          outcome.kind,
          "Daytona file read did not complete.",
        );
      if (outcome.value.byteLength > this.maxFileBytes)
        throw providerError(
          this.binding.providerId,
          "readFile",
          "failed",
          "Daytona file exceeded its limit.",
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
        cause instanceof Error ? cause.message : "Daytona file read failed.",
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
    const bytes = new Uint8Array(file.bytes);
    if (bytes.byteLength > this.maxFileBytes)
      throw providerError(
        this.binding.providerId,
        "writeFile",
        "invalid_request",
        "Daytona file exceeded its limit.",
        "The sandbox file is too large.",
      );
    try {
      const outcome = await raceSdk(
        this.sandbox.fs.uploadFile(bytes, path, controlTimeoutSeconds),
        context.signal,
        controlTimeoutSeconds,
      );
      if (outcome.kind !== "value")
        throw operationFailure(
          this.binding.providerId,
          "writeFile",
          outcome.kind,
          "Daytona file write could not be verified.",
        );
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      throw providerError(
        this.binding.providerId,
        "writeFile",
        "failed",
        cause instanceof Error ? cause.message : "Daytona file write failed.",
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
      const shutdownContext: ProviderOperationContext = {
        signal,
        operationId: `shutdown-${this.id}`,
        workspaceId: this.binding.workspaceId,
        ...(this.binding.tenantId ? { tenantId: this.binding.tenantId } : {}),
        ...(this.binding.userId ? { userId: this.binding.userId } : {}),
      };
      await this.inspect(this.sandbox, shutdownContext, "destroy");
    }
    void reason;
    try {
      const outcome = await raceSdk(
        this.sandbox.delete(Math.min(this.maxSeconds, controlTimeoutSeconds), true),
        signal,
        Math.min(this.maxSeconds, controlTimeoutSeconds),
      );
      if (outcome.kind !== "value")
        throw operationFailure(
          this.binding.providerId,
          "destroy",
          outcome.kind,
          "Daytona sandbox cleanup could not be verified.",
        );
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      throw providerError(
        this.binding.providerId,
        "destroy",
        "unknown_outcome",
        cause instanceof Error ? cause.message : "Daytona sandbox cleanup failed.",
        "The sandbox cleanup outcome is unknown.",
      );
    }
    this.destroyed = true;
    markDestroyed(this.metadata);
  }

  async close(reason?: string): Promise<void> {
    await this.destroy(undefined, reason ?? "sandbox closed");
  }

  private ensureUsable(operation: string): void {
    this.ensureOpen(operation);
    if (this.destroyed)
      throw providerError(
        this.binding.providerId,
        operation,
        "failed",
        "The Daytona sandbox resource has already been destroyed.",
        "The sandbox is no longer available.",
      );
  }
}

export { configSchema as daytonaSandboxConfigSchema };
