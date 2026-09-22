import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { posix } from "node:path";
import {
  DockerUnknownOutcomeError,
  type DockerContainer,
  type DockerContainerSpec,
  type DockerExecOutcome,
  type DockerExecRequest,
  type DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import type { SandboxFile, SandboxLimits } from "@openmuse/provider-contracts";

export interface DockerCliRuntimeOptions {
  dockerBinary?: string;
  instanceId?: string;
  reaperIntervalMs?: number;
  onReaperError?: (error: unknown, containerId?: string) => void;
  maxFileBytes?: number;
  maxOutputBytes?: number;
}

const imageDigest = /^[^@\s]+@sha256:[0-9a-f]{64}$/i;
const containerId = /^[a-f0-9]{12,64}$/i;
const workspacePath = /^\/workspace(?:\/[^\0]*)?$/;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Supported sandbox images must ship this fixed, trusted interpreter. The
// helper below is passed as code, never as user input, and is verified at
// container creation before the container is handed to a caller.
const fileHelperBinary = "/usr/local/bin/python3";
const fileHelperProbe =
  "import os; fd=os.open('/workspace', os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); os.close(fd)";
const descriptorFileHelper = String.raw`import os, secrets, stat, sys

def fail(code=73):
    raise SystemExit(code)

def path_parts(value):
    if not isinstance(value, str) or not value.startswith('/workspace/') or '\x00' in value:
        fail()
    parts = value[len('/workspace/'):].split('/')
    if not parts or any(not part or part in ('.', '..') for part in parts):
        fail()
    return parts

def open_parent(parts):
    fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def read_file(parts):
    parent_fd = open_parent(parts)
    file_fd = -1
    try:
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent_fd)
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            fail()
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(1, view)
                view = view[written:]
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(parent_fd)

def write_file(parts):
    parent_fd = open_parent(parts)
    temporary = '.openmuse-' + str(os.getpid()) + '-' + secrets.token_hex(16)
    temporary_fd = -1
    try:
        try:
            if stat.S_ISLNK(os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False).st_mode):
                fail()
        except FileNotFoundError:
            pass
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        while True:
            chunk = os.read(0, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(temporary_fd, view)
                view = view[written:]
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        # renameat-style replacement is relative to the already-open parent
        # descriptor and never follows a final symlink.
        os.rename(temporary, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)

try:
    mode = sys.argv[1]
    parts = path_parts(sys.argv[2])
    if mode == 'read':
        read_file(parts)
    elif mode == 'write':
        write_file(parts)
    else:
        fail()
except SystemExit:
    raise
except OSError:
    raise SystemExit(74)
`;

interface SpawnOptions {
  input?: Uint8Array;
  signal?: AbortSignal;
  maxBytes?: number;
  onProcess?: (process: ChildProcessWithoutNullStreams) => void;
}

interface SpawnResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

export function createDockerCliRuntime(options: DockerCliRuntimeOptions = {}): DockerRuntime {
  const dockerBinary = options.dockerBinary ?? "docker";
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    maxFileBytes > 100 * 1024 * 1024 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > 20 * 1024 * 1024 ||
    (options.reaperIntervalMs !== undefined &&
      (!Number.isFinite(options.reaperIntervalMs) || options.reaperIntervalMs <= 0))
  )
    throw new Error("Docker runtime limits must be finite positive values within hard ceilings.");
  const operations = new Map<string, ChildProcessWithoutNullStreams>();
  const instanceId = options.instanceId;

  const run = (args: readonly string[], spawnOptions: SpawnOptions = {}): Promise<SpawnResult> =>
    runCommand(dockerBinary, args, spawnOptions);

  if (instanceId) {
    const interval = Math.max(1_000, options.reaperIntervalMs ?? 60_000);
    const timer = setInterval(() => {
      void reapExpired(run, instanceId, options.onReaperError);
    }, interval);
    timer.unref?.();
  }

  return {
    async create(spec: DockerContainerSpec, signal: AbortSignal): Promise<DockerContainer> {
      validateSpec(spec);
      const args = [
        "create",
        "--user",
        "65532:65532",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        String(Math.floor(spec.limits.pids ?? 128)),
        "--cpus",
        String(spec.limits.cpu ?? 1),
        "--memory",
        `${Math.floor(spec.limits.memoryMb ?? 512)}m`,
        "--read-only",
        "--tmpfs",
        `/workspace:rw,exec,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=${Math.floor(spec.limits.diskMb ?? 512)}m`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=64m",
        "--workdir",
        "/workspace",
      ];
      const containerLabels = {
        ...spec.labels,
        "openmuse.expires_at": new Date(
          Date.now() + (spec.limits.timeoutSeconds ?? 60) * 1000,
        ).toISOString(),
      };
      for (const [key, value] of Object.entries(containerLabels)) {
        if (!key || value.includes("\0")) throw new Error("Invalid Docker label.");
        args.push("--label", `${key}=${value}`);
      }
      args.push(spec.image, "tail", "-f", "/dev/null");
      const created = await run(args, { signal, maxBytes: 4096 });
      if (created.exitCode !== 0) throw new Error(text(created.stderr) || "Docker create failed.");
      const id = text(created.stdout).trim();
      validateContainerId(id);
      const started = await run(["start", id], { signal, maxBytes: 4096 });
      if (started.exitCode !== 0) {
        try {
          await removeContainerId(run, id);
        } catch (cleanupError) {
          throw new DockerUnknownOutcomeError(
            `Docker start failed and cleanup outcome is unknown: ${
              cleanupError instanceof Error ? cleanupError.message : "cleanup failed"
            }`,
            { cause: cleanupError },
          );
        }
        throw new Error(text(started.stderr) || "Docker start failed.");
      }
      try {
        await verifyFileHelper(run, id, signal);
      } catch (error) {
        try {
          await removeContainerId(run, id);
        } catch (cleanupError) {
          throw new DockerUnknownOutcomeError(
            `Docker file-helper verification failed and cleanup outcome is unknown: ${
              cleanupError instanceof Error ? cleanupError.message : "cleanup failed"
            }`,
            { cause: cleanupError },
          );
        }
        if (error instanceof Error && error.message) throw error;
        throw new Error("Docker image does not provide the trusted file helper.", { cause: error });
      }
      return new CliDockerContainer(id, run, operations, maxFileBytes, maxOutputBytes);
    },
    async get(id: string, signal: AbortSignal): Promise<DockerContainer> {
      validateContainerId(id);
      const result = await run(["inspect", id], { signal, maxBytes: 128 * 1024 });
      if (result.exitCode !== 0)
        throw new Error(text(result.stderr) || "Docker container was not found.");
      return new CliDockerContainer(id, run, operations, maxFileBytes, maxOutputBytes);
    },
  };
}

interface ManagedRuntimeSignal {
  signal: AbortSignal;
  dispose: () => void;
}

function boundedRuntimeSignal(parent?: AbortSignal, timeoutMs = 10_000): ManagedRuntimeSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("container operation deadline"), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(parent?.reason ?? "container operation cancelled");
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

class CliDockerContainer implements DockerContainer {
  constructor(
    readonly id: string,
    private readonly run: (args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>,
    private readonly operations: Map<string, ChildProcessWithoutNullStreams>,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
  ) {}

  async inspect(signal?: AbortSignal) {
    const bounded = boundedRuntimeSignal(signal);
    try {
      const result = await this.run(["inspect", "--format", "{{json .}}", this.id], {
        signal: bounded.signal,
        maxBytes: 128 * 1024,
      });
      if (result.exitCode !== 0) throw new Error(text(result.stderr) || "Docker inspect failed.");
      const value = JSON.parse(text(result.stdout)) as {
        Config?: { Image?: unknown; Labels?: unknown };
        State?: { Status?: unknown };
      };
      const status = value.State?.Status;
      return {
        status:
          status === "created"
            ? "creating"
            : status === "running"
              ? "running"
              : status === "exited" || status === "dead"
                ? "stopped"
                : "unknown",
        ...(typeof value.Config?.Image === "string" ? { image: value.Config.Image } : {}),
        labels: labels(value.Config?.Labels),
      } as const;
    } finally {
      bounded.dispose();
    }
  }

  async exec(request: DockerExecRequest): Promise<DockerExecOutcome> {
    validateExecRequest(request);
    const args = ["exec", "--workdir", request.cwd ?? "/workspace"];
    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (!envKey.test(key) || value.includes("\0") || value.length > 64 * 1024)
        throw new Error("Invalid sandbox environment variable.");
      args.push("--env", `${key}=${value}`);
    }
    args.push(this.id, ...request.argv);
    const key = operationKey(this.id, request.operationId);
    try {
      const result = await this.run(args, {
        signal: request.signal,
        maxBytes: this.maxOutputBytes,
        onProcess: (process) => this.operations.set(key, process),
      });
      this.operations.delete(key);
      return {
        exitCode: result.exitCode,
        stdout: text(result.stdout),
        stderr: text(result.stderr),
        timedOut: false,
        providerOperationId: request.operationId,
      };
    } catch (cause) {
      // Killing the host-side docker CLI does not kill the command started by
      // docker exec. Destroy the container here so every failed operation is
      // fail-closed, including output-limit and request-abort failures.
      try {
        await this.cancel(request.operationId);
      } catch (cleanupError) {
        throw new DockerUnknownOutcomeError(
          `Docker exec failed and cleanup outcome is unknown: ${
            cleanupError instanceof Error ? cleanupError.message : "cleanup failed"
          }`,
          { cause: cleanupError },
        );
      }
      throw cause;
    }
  }

  async readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const target = validatePath(path);
    return this.runFileHelper("read", target, signal);
  }

  async writeFile(file: SandboxFile, signal: AbortSignal): Promise<void> {
    if (file.bytes.byteLength > this.maxFileBytes)
      throw new Error("Sandbox file exceeds the size limit.");
    const target = validatePath(file.path);
    await this.runFileHelper("write", target, signal, file.bytes);
  }

  async cancel(operationId: string, signal?: AbortSignal): Promise<void> {
    const key = operationKey(this.id, operationId);
    if (!this.operations.has(key)) return;
    await removeContainerId(this.run, this.id, signal);
    for (const operation of this.operations.keys())
      if (operation.startsWith(`${this.id}\u0000`)) this.operations.delete(operation);
  }

  async destroy(_reason?: string, signal?: AbortSignal): Promise<void> {
    await removeContainerId(this.run, this.id, signal);
    for (const operation of this.operations.keys())
      if (operation.startsWith(`${this.id}\u0000`)) this.operations.delete(operation);
  }

  private async runFileHelper(
    mode: "read" | "write",
    path: string,
    signal: AbortSignal,
    input?: Uint8Array,
  ): Promise<Uint8Array> {
    let result: SpawnResult;
    try {
      result = await this.run(
        ["exec", "-i", this.id, fileHelperBinary, "-c", descriptorFileHelper, mode, path],
        {
          signal,
          ...(input ? { input } : {}),
          maxBytes: mode === "read" ? this.maxFileBytes : 4096,
        },
      );
    } catch (cause) {
      try {
        await removeContainerId(this.run, this.id);
      } catch (cleanupError) {
        throw new DockerUnknownOutcomeError(
          `Docker file ${mode} failed and cleanup outcome is unknown: ${
            cleanupError instanceof Error ? cleanupError.message : "cleanup failed"
          }`,
          { cause: cleanupError },
        );
      }
      throw cause;
    }
    if (result.exitCode !== 0)
      throw new Error(text(result.stderr) || `Docker file ${mode} failed.`);
    return result.stdout;
  }
}

function operationKey(containerIdValue: string, operationId: string): string {
  return `${containerIdValue}\u0000${operationId}`;
}

async function removeContainerId(
  run: (args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const ownedController = signal ? undefined : new AbortController();
  const timer = ownedController
    ? setTimeout(() => ownedController.abort("cleanup deadline"), 10_000)
    : undefined;
  timer?.unref?.();
  const cleanupSignal = signal ?? ownedController!.signal;
  try {
    const result = await run(["rm", "-f", id], { signal: cleanupSignal, maxBytes: 4096 });
    if (
      result.exitCode !== 0 &&
      !/no such container|no such object|is not running/i.test(text(result.stderr))
    )
      throw new Error(text(result.stderr) || "Docker container cleanup failed.");
    const inspected = await run(["inspect", id], { signal: cleanupSignal, maxBytes: 4096 });
    if (inspected.exitCode === 0)
      throw new Error("Docker container still exists after forced cleanup.");
    if (!/no such container|no such object|not found/i.test(text(inspected.stderr)))
      throw new Error(text(inspected.stderr) || "Docker cleanup could not be verified.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyFileHelper(
  run: (args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await run(["exec", id, fileHelperBinary, "-c", fileHelperProbe], {
    signal,
    maxBytes: 4096,
  });
  if (result.exitCode !== 0)
    throw new Error(
      text(result.stderr) || "Docker image does not provide the trusted file helper.",
    );
}

async function reapExpired(
  run: (args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>,
  instanceId: string,
  reportError: DockerCliRuntimeOptions["onReaperError"] = (error, id) => {
    console.error(
      `Docker sandbox reaper failed${id ? ` for ${id}` : ""}:`,
      error instanceof Error ? error.message : error,
    );
  },
): Promise<void> {
  try {
    const listed = await run(
      [
        "ps",
        "-aq",
        "--filter",
        "label=openmuse.provider=sandbox-docker",
        "--filter",
        `label=openmuse.instance_id=${instanceId}`,
      ],
      { maxBytes: 128 * 1024 },
    );
    if (listed.exitCode !== 0) {
      reportError(new Error(text(listed.stderr) || "Docker sandbox reaper listing failed."));
      return;
    }
    for (const id of text(listed.stdout).split(/\s+/).filter(Boolean)) {
      if (!containerId.test(id)) continue;
      const inspected = await run(["inspect", "--format", "{{json .Config.Labels}}", id], {
        maxBytes: 32 * 1024,
      });
      if (inspected.exitCode !== 0) {
        reportError(
          new Error(text(inspected.stderr) || "Docker sandbox reaper inspect failed."),
          id,
        );
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text(inspected.stdout)) as unknown;
      } catch (error) {
        reportError(error, id);
        continue;
      }
      const expiresAt = labels(value)["openmuse.expires_at"];
      if (
        !expiresAt ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) > Date.now()
      )
        continue;
      try {
        await removeContainerId(run, id);
      } catch (error) {
        // Leave the container for the next reconciliation pass. Cleanup
        // failures are never converted into a false-success response.
        reportError(error, id);
      }
    }
  } catch (error) {
    // The next interval retries the reconciliation. No caller operation is
    // told that an orphan was removed unless Docker confirms it.
    reportError(error);
  }
}

function validateSpec(spec: DockerContainerSpec): void {
  if (!imageDigest.test(spec.image)) throw new Error("Docker image must be digest pinned.");
  if (spec.privileged || spec.mounts.length !== 0 || !spec.networkDisabled)
    throw new Error("Unsafe Docker sandbox options were rejected.");
  if (
    !spec.labels["openmuse.workspace_id"] ||
    spec.labels["openmuse.provider"] !== "sandbox-docker" ||
    !spec.labels["openmuse.instance_id"] ||
    spec.labels["openmuse.user_id"] === undefined
  )
    throw new Error("Docker sandbox ownership labels are required.");
  validateLimits(spec.limits);
}

function validateLimits(limits: SandboxLimits): void {
  const values = [limits.cpu, limits.memoryMb, limits.diskMb, limits.pids, limits.timeoutSeconds];
  if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0)))
    throw new Error("Invalid Docker sandbox limits.");
  if (
    (limits.cpu ?? 1) > 8 ||
    (limits.memoryMb ?? 512) > 16_384 ||
    (limits.diskMb ?? 512) > 100_000 ||
    (limits.pids ?? 128) > 4_096 ||
    (limits.timeoutSeconds ?? 60) > 900
  )
    throw new Error("Docker sandbox limits exceed hard ceilings.");
}

function validateExecRequest(request: DockerExecRequest): void {
  if (
    request.argv.length === 0 ||
    request.argv.some((value) => value.includes("\0") || value.length > 64 * 1024)
  )
    throw new Error("Invalid sandbox argv.");
  if (request.cwd !== undefined) validatePath(request.cwd);
}

function validatePath(value: string): string {
  if (!workspacePath.test(value) || value.includes("\\"))
    throw new Error("Sandbox path must stay below /workspace.");
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "/workspace/" ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  )
    throw new Error("Sandbox path traversal was rejected.");
  return normalized;
}

function validateContainerId(value: string): void {
  if (!containerId.test(value)) throw new Error("Invalid Docker container id.");
}

function labels(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function terminate(process: ChildProcessWithoutNullStreams): void {
  if (process.exitCode !== null || process.killed) return;
  process.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (process.exitCode === null) process.kill("SIGKILL");
  }, 500);
  process.once("close", () => clearTimeout(timer));
}

function runCommand(
  binary: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: "pipe", env: process.env });
    let settled = false;
    let total = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const onAbort = () => terminate(child);
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(cause);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        terminate(child);
        fail(new Error("Docker command output exceeded its configured limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(Object.assign(new Error("Docker command cancelled."), { name: "AbortError" }));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? (signal ? 128 : 1),
      });
    });
    options.onProcess?.(child);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}
