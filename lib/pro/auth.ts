import { sha256Hex } from "./hash";

/**
 * Pro gate. There is no billing in this app: keys are issued by hand and the server stores only their SHA-256 hashes.
 * This is a modest improvement over one shared secret, not an entitlement system: no per-user accounts, no per-user revocation (removing a
 * hash revokes every holder of that key), no expiry enforcement. `issued_at` is informational.
 *
 * Env PRO_TOKEN_HASHES, either
 *   - a JSON array:  [{"hash":"<64 hex>","label":"launch","issued_at":"2026-10-22"}, ...]   (what scripts/rotate-pro-key.mjs prints), or
 *   - comma-separated bare hashes (the original format; label becomes "key-<first 8 hex>").
 * Several entries may be live at once, which is what makes rotation possible without downtime.
 */
export interface ProKey {
  hash: string;
  label: string;
  issuedAt?: string;
}

const HASH = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

export function parseProKeys(env: string | undefined): { keys: ProKey[]; errors: string[] } {
  const keys: ProKey[] = [];
  const errors: string[] = [];
  const add = (hash: unknown, label: unknown, issued: unknown, where: string) => {
    const h = typeof hash === "string" ? hash.trim().toLowerCase() : "";
    if (!HASH.test(h)) return void errors.push(`${where}: hash is not 64 hex characters`);
    if (keys.some((k) => k.hash === h)) return void errors.push(`${where}: duplicate hash`);
    const l = label === undefined ? `key-${h.slice(0, 8)}` : label;
    if (typeof l !== "string" || !LABEL.test(l)) return void errors.push(`${where}: label must be 1-40 chars of letters, digits, space . _ -`);
    if (issued !== undefined && (typeof issued !== "string" || !WHEN.test(issued))) return void errors.push(`${where}: issued_at must look like 2026-10-22`);
    keys.push({ hash: h, label: l, ...(issued ? { issuedAt: issued as string } : {}) });
  };
  const raw = (env ?? "").trim();
  if (!raw) return { keys, errors };
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) errors.push("PRO_TOKEN_HASHES JSON must be an array");
      else arr.forEach((e, i) => (e && typeof e === "object" ? add((e as Record<string, unknown>).hash, (e as Record<string, unknown>).label, (e as Record<string, unknown>).issued_at, `entry ${i}`) : errors.push(`entry ${i}: not an object`)));
    } catch {
      errors.push("PRO_TOKEN_HASHES looks like JSON but does not parse");
    }
  } else raw.split(",").forEach((h, i) => h.trim() && add(h, undefined, undefined, `entry ${i}`));
  return { keys, errors };
}

export type AuthResult = { status: "ok"; key: ProKey } | { status: "missing" | "invalid" | "not-configured" };

export async function verifyProToken(authHeader: string | null, keys: readonly ProKey[]): Promise<AuthResult> {
  if (keys.length === 0) return { status: "not-configured" };
  const m = /^Bearer\s+(\S{8,200})$/.exec(authHeader ?? "");
  if (!m) return { status: "missing" };
  const h = await sha256Hex(m[1]!);
  const key = keys.find((k) => k.hash === h); // comparing hashes, not secrets: a plain compare leaks nothing useful
  return key ? { status: "ok", key } : { status: "invalid" };
}
