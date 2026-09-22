import { z } from "zod";
import {
  ProviderOperationError,
  createSandboxScopeToken,
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
 * The Docker provider deliberately has no Docker socket discovery. A trusted
 * local service injects this runtime; API and general workers cannot use this
 * package to reach a host daemon accidentally.
 */
export interface DockerContainerSpec {
  image: string;
  labels: Readonly<Record<string, string>>;
  limits: SandboxLimits;
  networkDisabled: true;
  privileged: false;
  mounts: readonly [];
}

export interface DockerExecRequest extends SandboxExecRequest {
  operationId: string;
  signal: AbortSignal;
}

export interface DockerExecOutcome extends SandboxExecResult {
  providerOperationId: string;
}

/**
 * A Docker operation failed after its container cleanup could not be verified.
 * The provider adapter preserves this marker as `unknown_outcome` instead of
 * turning an uncertain result into an ordinary failure.
 */
export class DockerUnknownOutcomeError extends Error {
  readonly unknownOutcome = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DockerUnknownOutcomeError";
  }
}

export interface DockerContainer {
  readonly id: string;
  inspect(signal?: AbortSignal): Promise<{
    status: "creating" | "running" | "stopped" | "destroyed" | "unknown";
    image?: string;
    labels: Readonly<Record<string, string>>;
  }>;
  exec(request: DockerExecRequest): Promise<DockerExecOutcome>;
  readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(file: SandboxFile, signal: AbortSignal): Promise<void>;
  cancel?(operationId: string, signal?: AbortSignal): Promise<void>;
  destroy(reason?: string, signal?: AbortSignal): Promise<void>;
}

export interface DockerRuntime {
  create(spec: DockerContainerSpec, signal: AbortSignal): Promise<DockerContainer>;
  get(id: string, signal: AbortSignal): Promise<DockerContainer>;
}

export interface HttpDockerRuntimeOptions {
  endpoint: string;
  serviceToken: string;
  workspaceId: string;
  providerId: string;
  instanceId: string;
  userId?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface DockerSandboxDriverOptions {
  runtime?: DockerRuntime;
  providerId?: string;
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
    image: z.string().trim().min(1).optional(),
    hosted: z.boolean().default(false),
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

const containerOperationTimeoutMs = 10_000;

const pinnedImage = /^[^@\s]+@sha256:[0-9a-f]{64}$/i;

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

function workspaceId(
  createContext: ProviderCreateContext,
  context?: ProviderOperationContext,
): string {
  const expected = createContext.workspaceId;
  const actual = context?.workspaceId ?? expected;
  if (!expected || !actual || actual !== expected)
    throw providerError(
      "sandbox-docker",
      "workspace",
      "permission_denied",
      "A sandbox workspace binding is required and cannot change during reconnect.",
      "The sandbox is not available in this workspace.",
    );
  return expected;
}

function assertPinnedImage(
  image: string,
  allowedImages: readonly string[],
  providerId: string,
): void {
  if (!pinnedImage.test(image))
    throw providerError(
      providerId,
      "create",
      "invalid_request",
      "Docker sandbox images must be pinned by a sha256 digest.",
      "The sandbox image is not allowed.",
    );
  if (allowedImages.length === 0 || !allowedImages.includes(image))
    throw providerError(
      providerId,
      "create",
      "permission_denied",
      "The requested Docker image is not in the provider allowlist.",
      "The sandbox image is not allowed.",
    );
}

function mergeLimits(config: DockerSandboxConfig, request: SandboxCreateRequest): SandboxLimits {
  const aliases: SandboxLimits = {
    ...(request.cpu === undefined ? {} : { cpu: request.cpu }),
    ...(request.memoryMb === undefined ? {} : { memoryMb: request.memoryMb }),
    ...(request.timeoutSeconds === undefined ? {} : { timeoutSeconds: request.timeoutSeconds }),
  };
  const merged = {
    ...defaultLimits,
    timeoutSeconds: Math.min(defaultLimits.timeoutSeconds, config.maxSeconds),
    ...config.maxLimits,
    ...request.limits,
    ...aliases,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || !Number.isFinite(value) || value <= 0)
      throw providerError(
        "sandbox-docker",
        "create",
        "invalid_request",
        `Invalid sandbox limit ${key}.`,
      );
  }
  if ((merged.timeoutSeconds ?? defaultLimits.timeoutSeconds) > config.maxSeconds)
    throw providerError(
      "sandbox-docker",
      "create",
      "invalid_request",
      "The sandbox timeout exceeds the provider limit.",
    );
  for (const [key, maximum] of Object.entries({
    cpu: 8,
    memoryMb: 16_384,
    diskMb: 100_000,
    pids: 4_096,
    timeoutSeconds: config.maxSeconds,
  })) {
    const value = merged[key as keyof SandboxLimits];
    if (value !== undefined && value > maximum)
      throw providerError(
        "sandbox-docker",
        "create",
        "invalid_request",
        `Sandbox limit ${key} is too high.`,
      );
  }
  for (const key of ["cpu", "memoryMb", "diskMb", "pids", "timeoutSeconds"] as const) {
    const configuredMaximum = config.maxLimits?.[key];
    const value = merged[key];
    if (configuredMaximum !== undefined && value !== undefined && value > configuredMaximum)
      throw providerError(
        "sandbox-docker",
        "create",
        "invalid_request",
        `Sandbox limit ${key} exceeds the configured provider ceiling.`,
      );
  }
  return merged;
}

function safeWorkspacePath(value: string, operation: string): string {
  if (!value.startsWith("/workspace/") && value !== "/workspace")
    throw providerError(
      "sandbox-docker",
      operation,
      "invalid_request",
      "Sandbox files must stay below /workspace.",
      "The sandbox path is not allowed.",
    );
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "."))
    throw providerError(
      "sandbox-docker",
      operation,
      "invalid_request",
      "Sandbox paths cannot contain traversal segments.",
      "The sandbox path is not allowed.",
    );
  return normalized;
}

function childSignal(
  parent: AbortSignal,
  timeoutSeconds: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort("sandbox timeout");
  }, timeoutSeconds * 1000);
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}

interface ManagedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

function boundedSignal(
  parent: AbortSignal | undefined,
  timeoutMs = containerOperationTimeoutMs,
): ManagedSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("container operation deadline"), timeoutMs);
  const abort = () => controller.abort(parent?.reason ?? "container operation cancelled");
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "The operation was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * AbortSignal cancellation must also bound provider implementations that do
 * not correctly observe their signal. The underlying promise remains owned by
 * the provider, but its rejection is consumed so it cannot become unhandled.
 */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    const pending = signal.aborted
      ? Promise.reject<T>(abortError(signal))
      : Promise.resolve().then(operation);
    pending.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertNotAborted(
  context: ProviderOperationContext,
  operation: string,
  providerId: string,
): void {
  if (context.signal.aborted)
    throw providerError(
      providerId,
      operation,
      "cancelled",
      "The sandbox operation was cancelled.",
      "The sandbox operation was cancelled.",
    );
}

function matchesBinding(
  labels: Readonly<Record<string, string>>,
  createContext: ProviderCreateContext,
  providerId: string,
  instanceId: string,
  operation?: ProviderOperationContext,
): boolean {
  if (
    labels["openmuse.workspace_id"] !== createContext.workspaceId ||
    labels["openmuse.provider"] !== providerId ||
    labels["openmuse.instance_id"] !== instanceId ||
    labels["openmuse.user_id"] !== (createContext.userId ?? "")
  )
    return false;
  if (operation?.workspaceId !== undefined && operation.workspaceId !== createContext.workspaceId)
    return false;
  if (operation?.userId !== undefined && operation.userId !== createContext.userId) return false;
  return true;
}

interface DockerSandboxConfig extends SandboxConfig {
  hosted: boolean;
  allowedImages: string[];
  maxSeconds: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

export function createDockerSandboxDriver(options: DockerSandboxDriverOptions = {}): SandboxDriver {
  const providerId = options.providerId ?? "sandbox-docker";
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const displayName = options.displayName ?? "Docker sandbox (trusted local)";
  const driver: SandboxDriver = {
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
      requiredSecrets: [],
      trusted: true,
    },
    config: { version: "1", schema: configSchema },
    async create(
      rawConfig: SandboxConfig,
      rawCreateContext: ProviderCreateContext,
    ): Promise<SandboxClient> {
      const createContext = Object.freeze({ ...rawCreateContext });
      const config = configSchema.parse(rawConfig) as DockerSandboxConfig;
      if (config.hosted)
        throw providerError(
          providerId,
          "configure",
          "permission_denied",
          "Docker hosted mode is disabled.",
        );
      if (!options.runtime)
        throw providerError(
          providerId,
          "configure",
          "unavailable",
          "A trusted local Docker runtime must be injected into the sandbox service.",
        );
      if (!createContext.workspaceId)
        throw providerError(
          providerId,
          "configure",
          "invalid_request",
          "A workspace binding is required.",
        );
      const runtime = options.runtime;
      const owned = new Map<string, SandboxResource>();
      let closed = false;

      const ensureOpen = (operation: string) => {
        if (closed)
          throw providerError(providerId, operation, "failed", "The sandbox client is closed.");
      };

      const reconnect = async (
        id: string,
        operation: ProviderOperationContext,
      ): Promise<Sandbox> => {
        ensureOpen("reconnect");
        const boundWorkspace = workspaceId(createContext, operation);
        if (!id.trim())
          throw providerError(
            providerId,
            "reconnect",
            "invalid_request",
            "Sandbox id is required.",
          );
        assertNotAborted(operation, "reconnect", providerId);
        const container = await runtime.get(id, operation.signal).catch((error) => {
          throw providerError(
            providerId,
            "reconnect",
            "not_found",
            error instanceof Error ? error.message : "Docker sandbox was not found.",
            "The sandbox was not found.",
          );
        });
        const inspected = await abortable(
          () => container.inspect(operation.signal),
          operation.signal,
        );
        if (!matchesBinding(inspected.labels, createContext, providerId, instanceId, operation))
          throw providerError(
            providerId,
            "reconnect",
            "permission_denied",
            "Docker sandbox workspace label did not match the requested workspace.",
            "The sandbox is not available in this workspace.",
          );
        const metadata: SandboxMetadata = {
          id: container.id,
          providerId,
          workspaceId: boundWorkspace,
          ...(inspected.image ? { image: inspected.image } : {}),
          status: inspected.status,
          limits: {
            ...defaultLimits,
            ...config.maxLimits,
            timeoutSeconds: Math.min(
              config.maxLimits?.timeoutSeconds ?? defaultLimits.timeoutSeconds,
              config.maxSeconds,
            ),
          },
        };
        const resource = new SandboxResource(
          container,
          metadata,
          providerId,
          boundWorkspace,
          instanceId,
          config.maxFileBytes,
          config.maxOutputBytes,
          createContext.userId,
          ensureOpen,
        );
        owned.set(resource.id, resource);
        return resource;
      };

      return {
        async create(
          request: SandboxCreateRequest,
          operation: ProviderOperationContext,
        ): Promise<Sandbox> {
          ensureOpen("create");
          const boundWorkspace = workspaceId(createContext, operation);
          assertNotAborted(operation, "create", providerId);
          if (request.workspaceId !== undefined && request.workspaceId !== boundWorkspace)
            throw providerError(
              providerId,
              "create",
              "permission_denied",
              "A sandbox workspace binding is required and cannot change during creation.",
              "The sandbox is not available in this workspace.",
            );
          const image = request.image ?? config.image;
          if (!image)
            throw providerError(
              providerId,
              "create",
              "invalid_request",
              "A sandbox image is required.",
            );
          assertPinnedImage(image, config.allowedImages, providerId);
          const limits = mergeLimits(config, request);
          let container: DockerContainer;
          try {
            container = await runtime.create(
              {
                image,
                labels: {
                  "openmuse.provider": providerId,
                  "openmuse.workspace_id": boundWorkspace,
                  "openmuse.instance_id": instanceId,
                  "openmuse.user_id": createContext.userId ?? "",
                },
                limits,
                networkDisabled: true,
                privileged: false,
                mounts: [],
              },
              operation.signal,
            );
          } catch (error) {
            if (isDockerUnknownOutcome(error))
              throw providerError(
                providerId,
                "create",
                "unknown_outcome",
                error instanceof Error
                  ? error.message
                  : "Docker sandbox creation cleanup is unknown.",
                "The sandbox creation cleanup outcome is unknown.",
              );
            if (operation.signal.aborted)
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
              error instanceof Error ? error.message : "Docker sandbox creation failed.",
              "The sandbox could not be created.",
            );
          }
          const metadata: SandboxMetadata = {
            id: container.id,
            providerId,
            workspaceId: boundWorkspace,
            image,
            status: "running",
            createdAt: new Date().toISOString(),
            limits,
          };
          const resource = new SandboxResource(
            container,
            metadata,
            providerId,
            boundWorkspace,
            instanceId,
            config.maxFileBytes,
            config.maxOutputBytes,
            createContext.userId,
            ensureOpen,
          );
          owned.set(resource.id, resource);
          return resource;
        },
        get: reconnect,
        reconnect,
        async destroy(id: string, operation: ProviderOperationContext): Promise<void> {
          const resource = await reconnect(id, operation);
          await resource.destroy(operation);
          owned.delete(id);
        },
        async close(reason?: string): Promise<void> {
          if (closed) return;
          closed = true;
          const failures: unknown[] = [];
          for (const resource of owned.values()) {
            try {
              await resource.destroy(undefined, reason);
            } catch (error) {
              failures.push(error);
            }
          }
          owned.clear();
          if (failures.length > 0)
            throw providerError(
              providerId,
              "close",
              "unknown_outcome",
              `Failed to destroy ${failures.length} Docker sandbox resource(s).`,
              "The sandbox cleanup outcome is unknown.",
              { details: { failureCount: failures.length } },
            );
        },
      };
    },
  };
  return driver;
}

/**
 * Runtime used by API/general workers. It speaks to the dedicated local
 * sandbox service and never opens a Docker socket itself.
 */
export function createHttpDockerRuntime(options: HttpDockerRuntimeOptions): DockerRuntime {
  const endpoint = options.endpoint.replace(/\/$/, "");
  if (!/^https?:\/\//.test(endpoint)) throw new Error("Sandbox service endpoint must be HTTP(S).");
  if (!options.serviceToken.trim()) throw new Error("Sandbox service token is required.");
  const doFetch = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> => {
    const headers = new Headers(init.headers);
    const token = await createSandboxScopeToken(options.serviceToken, {
      workspaceId: options.workspaceId,
      providerId: options.providerId,
      instanceId: options.instanceId,
      ...(options.userId ? { userId: options.userId } : {}),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await abortable(
      () => doFetch(`${endpoint}${path}`, { ...init, headers, signal }),
      signal,
    );
    const raw = await response.text();
    let value: unknown;
    try {
      value = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const code =
        value && typeof value === "object" && "code" in value && value.code === "unknown_outcome"
          ? "unknown_outcome"
          : undefined;
      if (code === "unknown_outcome")
        throw new DockerUnknownOutcomeError("The sandbox service cleanup outcome is unknown.");
      const message =
        value && typeof value === "object" && "error" in value && typeof value.error === "string"
          ? value.error
          : `Sandbox service returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return value as T;
  };
  return {
    async create(spec, signal) {
      const response = await request<{ id: string }>(
        "/v1/sandboxes",
        { method: "POST", body: JSON.stringify(spec) },
        signal,
      );
      return new HttpDockerContainer(response.id, request);
    },
    async get(id, signal) {
      validateContainerId(id);
      await request(`/v1/sandboxes/${encodeURIComponent(id)}`, { method: "GET" }, signal);
      return new HttpDockerContainer(id, request);
    },
  };
}

type HttpRequest = <T>(path: string, init: RequestInit, signal: AbortSignal) => Promise<T>;

class HttpDockerContainer implements DockerContainer {
  constructor(
    readonly id: string,
    private readonly request: HttpRequest,
  ) {}

  async inspect(signal?: AbortSignal) {
    const bounded = boundedSignal(signal);
    try {
      return await abortable(
        () =>
          this.request<{
            status: "creating" | "running" | "stopped" | "destroyed" | "unknown";
            image?: string;
            labels: Readonly<Record<string, string>>;
          }>(`/v1/sandboxes/${encodeURIComponent(this.id)}`, { method: "GET" }, bounded.signal),
        bounded.signal,
      );
    } finally {
      bounded.dispose();
    }
  }

  async exec(request: DockerExecRequest): Promise<DockerExecOutcome> {
    return this.request<DockerExecOutcome>(
      `/v1/sandboxes/${encodeURIComponent(this.id)}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          argv: request.argv,
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.env ? { env: request.env } : {}),
          operationId: request.operationId,
          timeoutSeconds: request.timeoutSeconds,
        }),
      },
      request.signal,
    );
  }

  async readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request<{ bytesBase64: string }>(
      `/v1/sandboxes/${encodeURIComponent(this.id)}/files/read`,
      { method: "POST", body: JSON.stringify({ path }) },
      signal,
    );
    return fromBase64(response.bytesBase64);
  }

  async writeFile(file: SandboxFile, signal: AbortSignal): Promise<void> {
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(this.id)}/files/write`,
      {
        method: "POST",
        body: JSON.stringify({
          path: file.path,
          bytesBase64: toBase64(file.bytes),
          contentType: file.contentType,
        }),
      },
      signal,
    );
  }

  async cancel(operationId: string, signal?: AbortSignal): Promise<void> {
    const bounded = boundedSignal(signal);
    try {
      await abortable(
        () =>
          this.request(
            `/v1/sandboxes/${encodeURIComponent(this.id)}/operations/${encodeURIComponent(operationId)}/cancel`,
            { method: "POST" },
            bounded.signal,
          ),
        bounded.signal,
      );
    } finally {
      bounded.dispose();
    }
  }

  async destroy(reason?: string, signal?: AbortSignal): Promise<void> {
    void reason;
    const bounded = boundedSignal(signal);
    try {
      await abortable(
        () =>
          this.request(
            `/v1/sandboxes/${encodeURIComponent(this.id)}`,
            { method: "DELETE" },
            bounded.signal,
          ),
        bounded.signal,
      );
    } finally {
      bounded.dispose();
    }
  }
}

function validateContainerId(id: string): void {
  if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error("Invalid Docker container id.");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

class SandboxResource implements Sandbox {
  readonly id: string;
  readonly metadata: SandboxMetadata;
  private destroyed = false;

  constructor(
    private readonly container: DockerContainer,
    metadata: SandboxMetadata,
    private readonly providerId: string,
    private readonly boundWorkspaceId: string,
    private readonly boundInstanceId: string,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
    private readonly boundUserId: string | undefined,
    private readonly ensureOpen: (operation: string) => void,
  ) {
    this.id = container.id;
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
    assertNotAborted(context, "execute", this.providerId);
    await this.assertOwnership("execute", context.signal, context);
    if (request.argv.length === 0 || request.argv.some((argument) => typeof argument !== "string"))
      throw providerError(
        this.providerId,
        "execute",
        "invalid_request",
        "Sandbox argv must not be empty.",
      );
    if (request.cwd) safeWorkspacePath(request.cwd, "execute");
    const timeoutSeconds = request.timeoutSeconds ?? this.metadata.limits.timeoutSeconds ?? 60;
    if (
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      timeoutSeconds > (this.metadata.limits.timeoutSeconds ?? timeoutSeconds)
    )
      throw providerError(
        this.providerId,
        "execute",
        "invalid_request",
        "Sandbox command timeout exceeds its limit.",
      );
    const child = childSignal(context.signal, timeoutSeconds);
    try {
      const result = await this.container.exec({
        ...request,
        operationId: context.operationId,
        signal: child.signal,
      });
      if (
        new TextEncoder().encode(result.stdout).byteLength > this.maxOutputBytes ||
        new TextEncoder().encode(result.stderr).byteLength > this.maxOutputBytes
      )
        throw providerError(
          this.providerId,
          "execute",
          "failed",
          "Docker sandbox output exceeded its configured size limit.",
          "The sandbox produced too much output.",
        );
      return child.timedOut()
        ? { ...result, timedOut: true, exitCode: result.exitCode === 0 ? 124 : result.exitCode }
        : result;
    } catch (error) {
      if (isDockerUnknownOutcome(error))
        throw providerError(
          this.providerId,
          "execute",
          "unknown_outcome",
          error instanceof Error ? error.message : "Docker sandbox cleanup outcome is unknown.",
          "The sandbox command cleanup outcome is unknown.",
        );
      if (child.timedOut()) {
        const cancellation = boundedSignal(undefined);
        try {
          await abortable(
            () =>
              this.container.cancel?.(context.operationId, cancellation.signal) ??
              Promise.resolve(),
            cancellation.signal,
          );
        } catch (cancellationError) {
          throw providerError(
            this.providerId,
            "execute",
            "unknown_outcome",
            cancellationError instanceof Error
              ? cancellationError.message
              : "Docker sandbox cancellation failed.",
            "The sandbox command outcome is unknown.",
          );
        } finally {
          cancellation.dispose();
        }
        this.metadata.status = "destroyed";
        this.destroyed = true;
        return {
          exitCode: 124,
          stdout: "",
          stderr: "Sandbox command timed out.",
          timedOut: true,
          providerOperationId: context.operationId,
        };
      }
      if (context.signal.aborted) {
        this.metadata.status = "destroyed";
        this.destroyed = true;
        throw providerError(
          this.providerId,
          "execute",
          "cancelled",
          "The sandbox command was cancelled.",
        );
      }
      throw providerError(
        this.providerId,
        "execute",
        "failed",
        error instanceof Error ? error.message : "Docker sandbox command failed.",
        "The sandbox command failed.",
      );
    } finally {
      child.cleanup();
    }
  }

  async readFile(path: string, context: ProviderOperationContext): Promise<Uint8Array> {
    this.ensureUsable("readFile");
    assertNotAborted(context, "readFile", this.providerId);
    await this.assertOwnership("readFile", context.signal, context);
    return this.container
      .readFile(safeWorkspacePath(path, "readFile"), context.signal)
      .then((bytes) => {
        if (bytes.byteLength > this.maxFileBytes)
          throw providerError(
            this.providerId,
            "readFile",
            "failed",
            "Docker sandbox file exceeded its configured size limit.",
            "The sandbox file is too large.",
          );
        return bytes;
      })
      .catch((error) => {
        if (isDockerUnknownOutcome(error))
          throw providerError(
            this.providerId,
            "readFile",
            "unknown_outcome",
            error instanceof Error
              ? error.message
              : "Docker sandbox file cleanup outcome is unknown.",
            "The sandbox file read cleanup outcome is unknown.",
          );
        if (context.signal.aborted)
          throw providerError(
            this.providerId,
            "readFile",
            "cancelled",
            "The sandbox file read was cancelled.",
          );
        throw providerError(
          this.providerId,
          "readFile",
          "failed",
          error instanceof Error ? error.message : "Docker sandbox file read failed.",
          "The sandbox file could not be read.",
        );
      });
  }

  async writeFile(file: SandboxFile, context: ProviderOperationContext): Promise<void> {
    this.ensureUsable("writeFile");
    assertNotAborted(context, "writeFile", this.providerId);
    await this.assertOwnership("writeFile", context.signal, context);
    const bytes = new Uint8Array(file.bytes);
    if (bytes.byteLength > this.maxFileBytes)
      throw providerError(
        this.providerId,
        "writeFile",
        "invalid_request",
        "Docker sandbox file exceeds its configured size limit.",
        "The sandbox file is too large.",
      );
    await this.container
      .writeFile(
        { ...file, path: safeWorkspacePath(file.path, "writeFile"), bytes },
        context.signal,
      )
      .catch((error) => {
        if (isDockerUnknownOutcome(error))
          throw providerError(
            this.providerId,
            "writeFile",
            "unknown_outcome",
            error instanceof Error
              ? error.message
              : "Docker sandbox file cleanup outcome is unknown.",
            "The sandbox file write cleanup outcome is unknown.",
          );
        if (context.signal.aborted)
          throw providerError(
            this.providerId,
            "writeFile",
            "cancelled",
            "The sandbox file write was cancelled.",
          );
        throw providerError(
          this.providerId,
          "writeFile",
          "failed",
          error instanceof Error ? error.message : "Docker sandbox file write failed.",
          "The sandbox file could not be written.",
        );
      });
  }

  async destroy(context?: ProviderOperationContext, reason = "sandbox destroyed"): Promise<void> {
    if (this.destroyed) return;
    const lifecycle = boundedSignal(context?.signal);
    try {
      if (context) assertNotAborted(context, "destroy", this.providerId);
      try {
        await this.assertOwnership("destroy", lifecycle.signal, context);
      } catch (error) {
        if (error instanceof ProviderOperationError) throw error;
        throw providerError(
          this.providerId,
          "destroy",
          "unknown_outcome",
          error instanceof Error ? error.message : "Docker sandbox inspection failed.",
          "The sandbox cleanup outcome is unknown.",
        );
      }
      try {
        await abortable(() => this.container.destroy(reason, lifecycle.signal), lifecycle.signal);
      } catch (error) {
        throw providerError(
          this.providerId,
          "destroy",
          "unknown_outcome",
          error instanceof Error ? error.message : "Docker sandbox cleanup failed.",
          "The sandbox cleanup outcome is unknown.",
        );
      }
    } finally {
      lifecycle.dispose();
    }
    this.metadata.status = "destroyed";
    this.destroyed = true;
  }

  async close(reason?: string): Promise<void> {
    await this.destroy(undefined, reason ?? "sandbox closed");
  }

  private ensureUsable(operation: string): void {
    this.ensureOpen(operation);
    if (this.destroyed)
      throw providerError(
        this.providerId,
        operation,
        "failed",
        "The Docker sandbox resource has already been destroyed.",
        "The sandbox is no longer available.",
      );
  }

  private async assertOwnership(
    operation: string,
    signal: AbortSignal,
    context?: ProviderOperationContext,
  ): Promise<void> {
    const inspected = await abortable(() => this.container.inspect(signal), signal);
    if (
      inspected.labels["openmuse.workspace_id"] !== this.boundWorkspaceId ||
      inspected.labels["openmuse.provider"] !== this.providerId ||
      inspected.labels["openmuse.instance_id"] !== this.boundInstanceId ||
      inspected.labels["openmuse.user_id"] !== (this.boundUserId ?? "")
    )
      throw providerError(
        this.providerId,
        operation,
        "permission_denied",
        "Docker sandbox ownership labels no longer match the bound workspace.",
        "The sandbox is not available in this workspace.",
      );
    if (context && !matchesOperationBinding(context, this.boundWorkspaceId, this.boundUserId))
      throw providerError(
        this.providerId,
        operation,
        "permission_denied",
        "Docker sandbox operation binding did not match the resource owner.",
        "The sandbox is not available in this workspace.",
      );
    if (signal.aborted)
      throw providerError(
        this.providerId,
        operation,
        "cancelled",
        "The sandbox operation was cancelled.",
      );
  }
}

function matchesOperationBinding(
  context: ProviderOperationContext,
  boundWorkspaceId: string,
  userId: string | undefined,
): boolean {
  return (
    (context.workspaceId === undefined || context.workspaceId === boundWorkspaceId) &&
    (context.userId === undefined || context.userId === userId)
  );
}

function isDockerUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof DockerUnknownOutcomeError ||
    (typeof error === "object" &&
      error !== null &&
      "unknownOutcome" in error &&
      error.unknownOutcome === true) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "unknown_outcome")
  );
}

export { configSchema as dockerSandboxConfigSchema };
