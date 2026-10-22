import type { ChainConfig } from "../dsp/config";
import type { BypassMap } from "../dsp/configUtil";

/**
 * IndexedDB persistence (no dependency). Stores:
 *   sessions : one record per saved session (settings, decisions, metadata)
 *   audio    : the source PCM, as raw Float32Array channels
 *   renders  : render attempts, so an interrupted one can be re-run from the saved state
 *   settings : small key/value app settings
 *
 * AUDIO: an AudioBuffer is NOT structured-cloneable (structuredClone(audioBuffer) throws DataCloneError), so it can't be put in IDB.
 * We persist `{ sampleRate, channels: Float32Array[] }` (typed arrays ARE cloneable, byte-exact). The stored source is the chain's own
 * input (mono, 48 kHz, 32-bit float), so reopening reproduces the original render input bit for bit.
 */
export const DB_NAME = "vocal-repair";
export const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

export interface StoredAudio {
  id: string;
  sampleRate: number;
  /** Samples per channel. */
  length: number;
  channels: Float32Array[];
}

export type PopDecisionRecord = "none-needed" | "pending" | "confirmed" | "skipped";

export interface SessionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  /** Display name (usually the source file name). */
  name: string;
  createdAt: number;
  updatedAt: number;
  audioId: string;
  source: { originalName: string; sampleRate: number; channels: number; durationSec: number };
  presetId: string;
  /** The FULL resolved config in use, including user edits. */
  config: ChainConfig;
  bypass: BypassMap;
  printStartSec: number | null;
  pops: { decision: PopDecisionRecord; confirmedIds: number[] };
  metadata: { artist: string; track: string };
  exportFormat: "wav" | "mp3";
}

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: number;
  presetId: string;
  durationSec: number;
  bytes: number;
}

export type RenderStatus = "running" | "done" | "failed";
export interface RenderRecord {
  id: string;
  sessionId: string;
  startedAt: number;
  finishedAt: number | null;
  status: RenderStatus;
  error: string | null;
  /** Fingerprint of the config the render used. */
  configFingerprint: string;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

/** Stable short fingerprint of a config (FNV-1a over its JSON). Identifies which config a render used. */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class Storage {
  constructor(
    private readonly db: IDBDatabase,
    private readonly maxSessions: number,
  ) {}

  close(): void {
    this.db.close();
  }

  /** Writes the session (and, when given, its audio) in ONE transaction, then evicts the oldest sessions beyond the cap. */
  async saveSession(rec: SessionRecord, audio?: StoredAudio): Promise<{ evicted: string[] }> {
    if (audio && audio.id !== rec.audioId) throw new Error("audio.id must equal session.audioId"); // validate BEFORE opening the transaction
    const tx = this.db.transaction(["sessions", "audio"], "readwrite");
    tx.objectStore("sessions").put(rec);
    if (audio) tx.objectStore("audio").put(audio);
    await done(tx);
    return { evicted: await this.evictBeyondCap(rec.id) };
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    return req(this.db.transaction("sessions").objectStore("sessions").get(id));
  }

  async loadAudio(id: string): Promise<StoredAudio | undefined> {
    return req(this.db.transaction("audio").objectStore("audio").get(id));
  }

  /** Newest first. Does not load audio; `bytes` is computed from the stored length. */
  async listSessions(): Promise<SessionSummary[]> {
    const tx = this.db.transaction(["sessions", "audio"]);
    const sessions: SessionRecord[] = await req(tx.objectStore("sessions").getAll());
    return sessions
      .map((s) => ({
        id: s.id,
        name: s.name,
        updatedAt: s.updatedAt,
        presetId: s.presetId,
        durationSec: s.source.durationSec,
        bytes: Math.round(s.source.durationSec * s.source.sampleRate * Float32Array.BYTES_PER_ELEMENT),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteSession(id: string): Promise<void> {
    const s = await this.getSession(id);
    const tx = this.db.transaction(["sessions", "audio", "renders"], "readwrite");
    tx.objectStore("sessions").delete(id);
    if (s) tx.objectStore("audio").delete(s.audioId);
    const renders = tx.objectStore("renders").index("sessionId");
    const keys: IDBValidKey[] = await req(renders.getAllKeys(id));
    for (const k of keys) tx.objectStore("renders").delete(k);
    await done(tx);
  }

  private async evictBeyondCap(keep: string): Promise<string[]> {
    const all = await this.listSessions();
    const doomed = all.slice(this.maxSessions).filter((s) => s.id !== keep);
    for (const s of doomed) await this.deleteSession(s.id);
    return doomed.map((s) => s.id);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction("settings", "readwrite");
    tx.objectStore("settings").put({ key, value });
    await done(tx);
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const r = await req(this.db.transaction("settings").objectStore("settings").get(key));
    return r === undefined ? fallback : (r.value as T);
  }

  /** Records that a render started. If the page dies before `finishRender`, the record stays "running". */
  async beginRender(sessionId: string, configFingerprint: string): Promise<RenderRecord> {
    const rec: RenderRecord = {
      id: `${sessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      error: null,
      configFingerprint,
    };
    const tx = this.db.transaction("renders", "readwrite");
    tx.objectStore("renders").put(rec);
    await done(tx);
    return rec;
  }

  async finishRender(id: string, status: Exclude<RenderStatus, "running">, error: string | null = null): Promise<void> {
    const tx = this.db.transaction("renders", "readwrite");
    const store = tx.objectStore("renders");
    const rec: RenderRecord | undefined = await req(store.get(id));
    if (rec) store.put({ ...rec, status, error, finishedAt: Date.now() });
    await done(tx);
  }

  /** Renders still marked running. Call at startup, before this page starts any render of its own. */
  async findInterruptedRenders(): Promise<RenderRecord[]> {
    const all: RenderRecord[] = await req(this.db.transaction("renders").objectStore("renders").getAll());
    return all.filter((r) => r.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  }
}

export async function openStorage(opts: { factory?: IDBFactory; name?: string; maxSessions: number }): Promise<Storage> {
  const factory = opts.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!factory) throw new Error("IndexedDB is not available in this browser or mode (private browsing?). Sessions cannot be saved.");
  const open = factory.open(opts.name ?? DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
    if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
    if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    if (!db.objectStoreNames.contains("renders")) db.createObjectStore("renders", { keyPath: "id" }).createIndex("sessionId", "sessionId");
  };
  const db = await req(open);
  return new Storage(db, opts.maxSessions);
}

/** Browser helper: storage usage and whether the origin's storage is persistent (protected from eviction). */
export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false };
}
