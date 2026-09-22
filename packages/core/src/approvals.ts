import type { JsonObject } from "@openmuse/contracts";
import { CoreError } from "./errors.js";

export interface ApprovalBinding {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  runId: string;
  toolCallId: string;
  canonicalArguments: JsonObject;
  targetResources: JsonObject;
  providerInstanceId?: string;
  connectionId?: string;
  policyVersion: string;
}

export interface ApprovalPolicy {
  expiresAt: string;
  allowedOperations: readonly string[];
}

export interface ApprovalRecord {
  id: string;
  nonce: string;
  digest: string;
  binding: ApprovalBinding;
  policy: ApprovalPolicy;
  status: "pending" | "approved" | "denied" | "consumed";
  createdAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface ApprovalStore {
  insert(record: ApprovalRecord): Promise<void>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  /** Implementations must atomically transition pending -> approved/denied. */
  decide(
    id: string,
    expectedDigest: string,
    decision: "approve" | "deny",
    decidedAt: string,
    now: string,
  ): Promise<ApprovalRecord | undefined>;
  /** Implementations must atomically check status, digest, and expiry before consuming. */
  consume(
    id: string,
    expectedDigest: string,
    consumedAt: string,
    now: string,
  ): Promise<ApprovalRecord | undefined>;
}

export interface ApprovalDigest {
  digest(value: unknown): Promise<string>;
}

export interface ApprovalClock {
  now(): Date;
}
export interface ApprovalNonce {
  next(): string;
}

function randomNonce(): string {
  const cryptoApi = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoApi?.randomUUID)
    throw new CoreError("crypto_unavailable", "A cryptographic nonce generator is unavailable.");
  return cryptoApi.randomUUID();
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export class Sha256Digest implements ApprovalDigest {
  async digest(value: unknown): Promise<string> {
    if (!globalThis.crypto?.subtle)
      throw new CoreError("crypto_unavailable", "Cryptographic hashing is unavailable.");
    const bytes = new TextEncoder().encode(canonicalize(value));
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export class ApprovalService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly digest: ApprovalDigest,
    private readonly clock: ApprovalClock = { now: () => new Date() },
    private readonly nonce: ApprovalNonce = { next: randomNonce },
  ) {}

  async issue(
    id: string,
    binding: ApprovalBinding,
    policy: ApprovalPolicy,
  ): Promise<ApprovalRecord> {
    const nonce = this.nonce.next();
    const digest = await this.digest.digest({ binding, policy, nonce });
    const record: ApprovalRecord = {
      id,
      nonce,
      digest,
      binding,
      policy,
      status: "pending",
      createdAt: this.clock.now().toISOString(),
    };
    await this.store.insert(record);
    return record;
  }

  async decide(
    id: string,
    expectedDigest: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalRecord> {
    const now = this.clock.now().toISOString();
    const decided = await this.store.decide(id, expectedDigest, decision, now, now);
    if (decided) return decided;
    const record = await this.store.get(id);
    if (!record || record.digest !== expectedDigest)
      throw new CoreError("approval_invalid", "The approval is invalid.");
    if (Date.parse(record.policy.expiresAt) <= Date.parse(now))
      throw new CoreError("approval_expired", "The approval has expired.");
    throw new CoreError("approval_replayed", "The approval is no longer pending.");
  }

  async consume(id: string, binding: ApprovalBinding): Promise<ApprovalRecord> {
    const current = await this.store.get(id);
    if (!current || current.status !== "approved") {
      throw new CoreError("approval_invalid", "The approval is invalid or has already been used.");
    }
    const expectedDigest = await this.digest.digest({
      binding,
      policy: current.policy,
      nonce: current.nonce,
    });
    if (current.digest !== expectedDigest) {
      throw new CoreError("approval_invalid", "The approval does not match the requested action.");
    }
    const now = this.clock.now().toISOString();
    if (Date.parse(current.policy.expiresAt) <= Date.parse(now)) {
      throw new CoreError("approval_expired", "The approval has expired.");
    }
    const consumed = await this.store.consume(id, expectedDigest, now, now);
    if (!consumed) throw new CoreError("approval_replayed", "The approval has already been used.");
    return consumed;
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async insert(record: ApprovalRecord): Promise<void> {
    if (this.records.has(record.id))
      throw new CoreError("approval_conflict", "The approval already exists.");
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async decide(
    id: string,
    expectedDigest: string,
    decision: "approve" | "deny",
    decidedAt: string,
    now: string,
  ): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    if (
      !record ||
      record.digest !== expectedDigest ||
      record.status !== "pending" ||
      Date.parse(record.policy.expiresAt) <= Date.parse(now)
    )
      return undefined;
    record.status = decision === "approve" ? "approved" : "denied";
    record.decidedAt = decidedAt;
    this.records.set(id, record);
    return structuredClone(record);
  }

  async consume(
    id: string,
    expectedDigest: string,
    consumedAt: string,
    now: string,
  ): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    if (
      !record ||
      record.digest !== expectedDigest ||
      record.status !== "approved" ||
      Date.parse(record.policy.expiresAt) <= Date.parse(now)
    )
      return undefined;
    record.status = "consumed";
    record.consumedAt = consumedAt;
    this.records.set(id, record);
    return structuredClone(record);
  }
}
