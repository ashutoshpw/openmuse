export interface SandboxScopeClaims {
  workspaceId: string;
  providerId: string;
  instanceId: string;
  userId?: string;
  expiresAt: number;
}

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Signs a short-lived, scope-bound service credential. The secret is never
 * placed in the credential; only its HMAC is sent over the authenticated
 * service boundary.
 */
export async function createSandboxScopeToken(
  secret: string,
  claims: SandboxScopeClaims,
): Promise<string> {
  if (!secret.trim()) throw new Error("Sandbox scope secret is required.");
  if (!claims.workspaceId || !claims.providerId || !claims.instanceId)
    throw new Error("Sandbox scope claims are incomplete.");
  const payload = encode(JSON.stringify({ v: 1, ...claims }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  const encodedSignature = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `v1.${payload}.${encodedSignature}`;
}
