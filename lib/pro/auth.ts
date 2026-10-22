import { sha256Hex } from "./hash";

/**
 * Pro gate. There is no billing in this app yet: Pro keys are issued by hand and the server only stores their SHA-256 hashes
 * (env PRO_TOKEN_HASHES, comma-separated). A request must send `Authorization: Bearer <key>`.
 */
export async function verifyProToken(authHeader: string | null, allowedHashes: readonly string[]): Promise<"ok" | "missing" | "invalid" | "not-configured"> {
  if (allowedHashes.length === 0) return "not-configured";
  const m = /^Bearer\s+(\S{8,200})$/.exec(authHeader ?? "");
  if (!m) return "missing";
  const h = await sha256Hex(m[1]!);
  let ok = false;
  for (const a of allowedHashes) if (a.length === h.length && a === h) ok = true; // hashes, not secrets: plain compare is fine
  return ok ? "ok" : "invalid";
}

export const parseHashList = (env: string | undefined): string[] =>
  (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
