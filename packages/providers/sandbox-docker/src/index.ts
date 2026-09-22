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

export interface DockerContainer {
  readonly id: string;
  inspect(): Promise<{
    status: "creating" | "running" | "stopped" | "destroyed" | "unknown";
    image?: string;
    labels: Readonly<Record<string, string>>;
  }>;
  exec(request: DockerExecRequest): Promise<DockerExecOutcome>;
  readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(file: SandboxFile, signal: AbortSignal): Promise<void>;
  cancel?(operationId: string): Promise<void>;
  destroy(reason?: string): Promise<void>;
}

export interface DockerRuntime {
  create(spec: DockerContainerSpec, signal: AbortSignal): Promise<DockerContainer>;
  get(id: string, signal: AbortSignal): Promise<DockerContainer>;
}

export interface HttpDockerRuntimeOptions {
  endpoint: string;
  serviceToken: string;
  workspaceId?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface DockerSandboxDriverOptions {
  runtime?: DockerRuntime;
  providerId?: string;
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
  if (allowedImages.length > 0 && !allowedImages.includes(image))
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

interface DockerSandboxConfig extends SandboxConfig {
  hosted: boolean;
  allowedImages: string[];
  maxSeconds: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

export function createDockerSandboxDriver(options: DockerSandboxDriverOptions = {}): SandboxDriver {
  const providerId = options.providerId ?? "sandbox-docker";
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
      createContext: ProviderCreateContext,
    ): Promise<SandboxClient> {
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
        workspaceId(createContext, operation);
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
        const inspected = await container.inspect();
        if (
          inspected.labels["openmuse.workspace_id"] !== createContext.workspaceId ||
          inspected.labels["openmuse.provider"] !== providerId
        )
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
          workspaceId: createContext.workspaceId,
          ...(inspected.image ? { image: inspected.image } : {}),
          status: inspected.status,
          limits: { ...defaultLimits, ...config.maxLimits },
        };
        const resource = new SandboxResource(
          container,
          metadata,
          providerId,
          createContext.workspaceId,
          config.maxFileBytes,
          config.maxOutputBytes,
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
          const container = await runtime.create(
            {
              image,
              labels: {
                "openmuse.provider": providerId,
                "openmuse.workspace_id": boundWorkspace,
              },
              limits,
              networkDisabled: true,
              privileged: false,
              mounts: [],
            },
            operation.signal,
          );
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
            config.maxFileBytes,
            config.maxOutputBytes,
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
    headers.set("Authorization", `Bearer ${options.serviceToken}`);
    if (options.workspaceId) headers.set("X-OpenMuse-Workspace", options.workspaceId);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await doFetch(`${endpoint}${path}`, { ...init, headers, signal });
    const raw = await response.text();
    let value: unknown;
    try {
      value = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      value = undefined;
    }
    if (!response.ok) {
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

  async inspect() {
    return this.request<{
      status: "creating" | "running" | "stopped" | "destroyed" | "unknown";
      image?: string;
      labels: Readonly<Record<string, string>>;
    }>(
      `/v1/sandboxes/${encodeURIComponent(this.id)}`,
      { method: "GET" },
      new AbortController().signal,
    );
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

  async cancel(operationId: string): Promise<void> {
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(this.id)}/operations/${encodeURIComponent(operationId)}/cancel`,
      { method: "POST" },
      new AbortController().signal,
    );
  }

  async destroy(): Promise<void> {
    await this.request(
      `/v1/sandboxes/${encodeURIComponent(this.id)}`,
      { method: "DELETE" },
      new AbortController().signal,
    );
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
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
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
    this.ensureOpen("execute");
    assertNotAborted(context, "execute", this.providerId);
    await this.assertOwnership("execute", context.signal);
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
      if (child.timedOut()) {
        try {
          await this.container.cancel?.(context.operationId);
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
        }
        return {
          exitCode: 124,
          stdout: "",
          stderr: "Sandbox command timed out.",
          timedOut: true,
          providerOperationId: context.operationId,
        };
      }
      if (context.signal.aborted)
        throw providerError(
          this.providerId,
          "execute",
          "cancelled",
          "The sandbox command was cancelled.",
        );
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
    this.ensureOpen("readFile");
    assertNotAborted(context, "readFile", this.providerId);
    await this.assertOwnership("readFile", context.signal);
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
    this.ensureOpen("writeFile");
    assertNotAborted(context, "writeFile", this.providerId);
    await this.assertOwnership("writeFile", context.signal);
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
    if (context) {
      assertNotAborted(context, "destroy", this.providerId);
      await this.assertOwnership("destroy", context.signal);
    }
    try {
      await this.container.destroy(reason);
    } catch (error) {
      throw providerError(
        this.providerId,
        "destroy",
        "unknown_outcome",
        error instanceof Error ? error.message : "Docker sandbox cleanup failed.",
        "The sandbox cleanup outcome is unknown.",
      );
    }
    this.metadata.status = "destroyed";
    this.destroyed = true;
  }

  async close(reason?: string): Promise<void> {
    await this.destroy(undefined, reason ?? "sandbox closed");
  }

  private async assertOwnership(operation: string, signal: AbortSignal): Promise<void> {
    const inspected = await this.container.inspect();
    if (
      inspected.labels["openmuse.workspace_id"] !== this.boundWorkspaceId ||
      inspected.labels["openmuse.provider"] !== this.providerId
    )
      throw providerError(
        this.providerId,
        operation,
        "permission_denied",
        "Docker sandbox ownership labels no longer match the bound workspace.",
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

export { configSchema as dockerSandboxConfigSchema };
