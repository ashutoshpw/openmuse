import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { posix } from "node:path";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecOutcome,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import type { SandboxFile, SandboxLimits } from "@openmuse/provider-contracts";

export interface DockerCliRuntimeOptions {
  dockerBinary?: string;
  maxFileBytes?: number;
  maxOutputBytes?: number;
}

const imageDigest = /^[^@\s]+@sha256:[0-9a-f]{64}$/i;
const containerId = /^[a-f0-9]{12,64}$/i;
const workspacePath = /^\/workspace(?:\/[^\0]*)?$/;
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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
  const operations = new Map<string, ChildProcessWithoutNullStreams>();

  const run = (args: readonly string[], spawnOptions: SpawnOptions = {}): Promise<SpawnResult> =>
    runCommand(dockerBinary, args, spawnOptions);

  return {
    async create(spec: DockerContainerSpec, signal: AbortSignal): Promise<DockerContainer> {
      validateSpec(spec);
      const args = [
        "create",
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
        `/workspace:rw,exec,nosuid,nodev,size=${Math.floor(spec.limits.diskMb ?? 512)}m`,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--workdir",
        "/workspace",
      ];
      for (const [key, value] of Object.entries(spec.labels)) {
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
        await run(["rm", "-f", id], { maxBytes: 4096 }).catch(() => undefined);
        throw new Error(text(started.stderr) || "Docker start failed.");
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

class CliDockerContainer implements DockerContainer {
  constructor(
    readonly id: string,
    private readonly run: (args: readonly string[], options?: SpawnOptions) => Promise<SpawnResult>,
    private readonly operations: Map<string, ChildProcessWithoutNullStreams>,
    private readonly maxFileBytes: number,
    private readonly maxOutputBytes: number,
  ) {}

  async inspect() {
    const result = await this.run(["inspect", "--format", "{{json .}}", this.id], {
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
    const result = await this.run(args, {
      signal: request.signal,
      maxBytes: this.maxOutputBytes,
      onProcess: (process) => this.operations.set(request.operationId, process),
    }).finally(() => {
      this.operations.delete(request.operationId);
    });
    return {
      exitCode: result.exitCode,
      stdout: text(result.stdout),
      stderr: text(result.stderr),
      timedOut: false,
      providerOperationId: request.operationId,
    };
  }

  async readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const resolved = await this.resolvePath(path, signal, false);
    if (!resolved) throw new Error("Docker file path could not be resolved.");
    const result = await this.run(["exec", this.id, "cat", "--", resolved], {
      signal,
      maxBytes: this.maxFileBytes,
    });
    if (result.exitCode !== 0) throw new Error(text(result.stderr) || "Docker file read failed.");
    return result.stdout;
  }

  async writeFile(file: SandboxFile, signal: AbortSignal): Promise<void> {
    if (file.bytes.byteLength > this.maxFileBytes)
      throw new Error("Sandbox file exceeds the size limit.");
    const target = validatePath(file.path);
    const parent = posix.dirname(target);
    const parentResolved = await this.resolvePath(parent, signal, false);
    if (!parentResolved) throw new Error("Docker file parent could not be resolved.");
    assertWorkspacePath(parentResolved);
    const existing = await this.resolvePath(target, signal, true);
    if (existing !== undefined && existing !== target)
      throw new Error("Refusing to write through a symlink.");
    // The script is fixed, and the user path is passed as an argv value. It
    // refuses symlink targets and atomically replaces regular files.
    const script =
      'set -eu; if [ -L "$1" ]; then exit 73; fi; umask 077; tmp="$1.openmuse-tmp.$$"; trap \'rm -f -- "$tmp"\' EXIT; cat > "$tmp"; if [ -L "$1" ]; then exit 73; fi; mv -f -- "$tmp" "$1"; trap - EXIT';
    const result = await this.run(
      ["exec", "-i", this.id, "sh", "-c", script, "openmuse-write", target],
      {
        signal,
        input: file.bytes,
        maxBytes: 4096,
      },
    );
    if (result.exitCode !== 0) throw new Error(text(result.stderr) || "Docker file write failed.");
  }

  async cancel(operationId: string): Promise<void> {
    const process = this.operations.get(operationId);
    if (!process) return;
    terminate(process);
  }

  async destroy(): Promise<void> {
    const result = await this.run(["rm", "-f", this.id], { maxBytes: 4096 });
    if (result.exitCode !== 0 && !/no such container|is not running/i.test(text(result.stderr)))
      throw new Error(text(result.stderr) || "Docker container cleanup failed.");
  }

  private async resolvePath(
    path: string,
    signal: AbortSignal,
    allowMissing: boolean,
  ): Promise<string | undefined> {
    const target = validatePath(path);
    const script = 'set -eu; value=$(readlink -f -- "$1") || exit 74; printf \'%s\' "$value"';
    const result = await this.run(
      ["exec", this.id, "sh", "-c", script, "openmuse-realpath", target],
      {
        signal,
        maxBytes: 4096,
      },
    );
    if (result.exitCode !== 0) {
      if (allowMissing && /No such file|cannot readlink/i.test(text(result.stderr)))
        return undefined;
      throw new Error(text(result.stderr) || "Docker path resolution failed.");
    }
    const resolved = text(result.stdout).trim();
    assertWorkspacePath(resolved);
    return resolved;
  }
}

function validateSpec(spec: DockerContainerSpec): void {
  if (!imageDigest.test(spec.image)) throw new Error("Docker image must be digest pinned.");
  if (spec.privileged || spec.mounts.length !== 0 || !spec.networkDisabled)
    throw new Error("Unsafe Docker sandbox options were rejected.");
  if (!spec.labels["openmuse.workspace_id"] || !spec.labels["openmuse.provider"])
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

function assertWorkspacePath(value: string): void {
  if (!workspacePath.test(value) || (value !== "/workspace" && !value.startsWith("/workspace/")))
    throw new Error("Resolved sandbox path escaped /workspace.");
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
