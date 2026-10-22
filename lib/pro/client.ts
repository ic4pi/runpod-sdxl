import { PRO_CONFIG } from "./config";
import { tier1FallbackItems } from "./findings";
import { canonicalJson, sha256Hex } from "./hash";
import { PhrasingResultSchema, type PhrasedItem, type PhrasingPayload } from "./schema";
import { validatePhrasing } from "./validate";
import type { Storage } from "../storage/idb";

/**
 * Browser side of the Pro phrasing layer (Pro only; nothing in the Free path imports this).
 * Order: durable local cache -> (no Pro key? stop, zero network) -> POST /api/phrasing -> re-validate the answer locally -> cache.
 * It never throws and never returns nothing: every failure path returns Tier 1's own text with the reason.
 */
export type ClientSource = "llm" | "cache" | "tier1-fallback";
export interface ClientResult {
  source: ClientSource;
  items: PhrasedItem[];
  /** Why the standard (Tier 1) text is shown instead of reworded text. */
  fallbackReason?: string;
  /** Where a cached item came from. */
  cache?: "local" | "server";
}

export const PRO_KEY_SETTING = "proKey";
export const INSTALL_NONCE_SETTING = "installNonce";

export async function getInstallNonce(storage: Storage): Promise<string> {
  const have = await storage.getSetting<string | null>(INSTALL_NONCE_SETTING, null);
  if (have && have.length >= PRO_CONFIG.rateLimit.nonceMinChars) return have;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const nonce = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); // 48 hex chars
  await storage.setSetting(INSTALL_NONCE_SETTING, nonce);
  return nonce;
}

export const getProKey = (storage: Storage) => storage.getSetting<string | null>(PRO_KEY_SETTING, null);
export const setProKey = (storage: Storage, key: string | null) => storage.setSetting(PRO_KEY_SETTING, key);

export async function phrasingCacheKey(payload: PhrasingPayload): Promise<string> {
  return `phrasing:${await sha256Hex(canonicalJson({ v: PRO_CONFIG.promptVersion, payload }))}`;
}

export async function requestPhrasing(args: {
  payload: PhrasingPayload;
  storage: Storage;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): Promise<ClientResult> {
  const { payload, storage } = args;
  const fallback = (reason: string): ClientResult => ({ source: "tier1-fallback", items: tier1FallbackItems(payload), fallbackReason: reason });
  try {
    const key = await phrasingCacheKey(payload);

    const cached = await storage.getCached<PhrasedItem[]>(key);
    if (cached && validatePhrasing(payload, { items: cached }).ok) return { source: "cache", items: cached, cache: "local" };

    const proKey = await getProKey(storage);
    if (!proKey) return fallback("No Pro key: showing the standard text.");

    const nonce = await getInstallNonce(storage);
    const doFetch = args.fetchImpl ?? fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PRO_CONFIG.client.requestTimeoutMs);
    let res: Response;
    try {
      res = await doFetch(args.endpoint ?? "/api/phrasing", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${proKey}`, "x-install-nonce": nonce },
        body: JSON.stringify({ payload }),
        signal: ctl.signal,
      });
    } catch (e) {
      return fallback(`Could not reach the phrasing service (${e instanceof Error ? e.name : "network error"}): showing the standard text.`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const why = res.status === 401 ? "the Pro key was not accepted" : res.status === 429 ? "rate limit reached, try again later" : res.status === 503 ? "the service is not configured" : `service error ${res.status}`;
      return fallback(`AI phrasing unavailable (${why}): showing the standard text.`);
    }
    const parsed = PhrasingResultSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return fallback("The phrasing service returned an unexpected response: showing the standard text.");
    const body = parsed.data;
    if (body.source === "tier1-fallback") return { source: "tier1-fallback", items: tier1FallbackItems(payload), fallbackReason: `${body.fallback_reason ?? "model unavailable"}: showing the standard text.` };

    // Defence in depth: never trust the server's validation. Re-run it here before anything is shown or stored.
    const again = validatePhrasing(payload, { items: body.items });
    if (!again.ok) return fallback("The reworded text failed the local number check: showing the standard text.");
    await storage.putCached(key, again.items, PRO_CONFIG.cache.clientMaxEntries).catch(() => undefined);
    return { source: body.source, items: again.items, ...(body.source === "cache" ? { cache: "server" as const } : {}) };
  } catch (e) {
    return fallback(`AI phrasing failed (${e instanceof Error ? e.message : "unknown"}): showing the standard text.`);
  }
}
