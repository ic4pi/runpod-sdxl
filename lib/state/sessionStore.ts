"use client";

import { create } from "zustand";
import { openStorage, fingerprint, SCHEMA_VERSION, storageEstimate, type RenderRecord, type SessionRecord, type SessionSummary, type Storage } from "../storage/idb";
import { useChain } from "./chainStore";
import { renderHooks } from "./renderHooks";

interface SessionState {
  ready: boolean;
  sessions: SessionSummary[];
  currentId: string | null;
  lastSavedAt: number | null;
  /** A render the previous page left "running" (browser killed/suspended mid-render). */
  interrupted: { render: RenderRecord; name: string } | null;
  persisted: boolean | null;
  usage: { usage: number; quota: number } | null;
  error: string | null;
  init(): Promise<void>;
  saveNow(): Promise<void>;
  openSession(id: string): Promise<void>;
  removeSession(id: string): Promise<void>;
  resumeInterrupted(): Promise<void>;
  dismissInterrupted(): Promise<void>;
}

let storage: Storage | null = null;
let restoring = false;
let lastFingerprint = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
let activeRenderId: string | null = null;

/** Everything a session persists except the audio, as one comparable value. */
function snapshot(): Omit<SessionRecord, "id" | "createdAt" | "updatedAt" | "audioId" | "schemaVersion" | "name" | "source"> | null {
  const c = useChain.getState();
  if (!c.source || !c.analysis) return null;
  return {
    presetId: c.presetId,
    config: c.cfg,
    bypass: c.bypass,
    printStartSec: c.printStartSec,
    pops: { decision: c.popDecision, confirmedIds: c.confirmed ? c.confirmed.events.map((e) => e.id) : [] },
    metadata: c.metadata,
    exportFormat: c.exportFormat,
  };
}

export const useSessions = create<SessionState>()((set, get) => ({
  ready: false,
  sessions: [],
  currentId: null,
  lastSavedAt: null,
  interrupted: null,
  persisted: null,
  usage: null,
  error: null,

  init() {
    initPromise ??= (async () => {
      try {
        const cfg = useChain.getState().cfg;
        storage = await openStorage({ maxSessions: cfg.storage.maxSessions });
        // before this page starts any render of its own: whatever is still "running" belongs to a dead page
        const stuck = (await storage.findInterruptedRenders())[0];
        const sessions = await storage.listSessions();
        const named = stuck ? { render: stuck, name: sessions.find((s) => s.id === stuck.sessionId)?.name ?? "a saved session" } : null;
        let persisted: boolean | null = null;
        if (cfg.storage.requestPersistence && navigator.storage?.persist) persisted = await navigator.storage.persist();
        const est = await storageEstimate();
        set({ ready: true, sessions, interrupted: stuck && sessions.some((s) => s.id === stuck.sessionId) ? named : null, persisted: est?.persisted ?? persisted, usage: est ? { usage: est.usage, quota: est.quota } : null });
        if (stuck && !sessions.some((s) => s.id === stuck.sessionId)) await storage.finishRender(stuck.id, "failed", "session no longer exists");

        renderHooks.begin = async () => {
          if (!get().currentId) await get().saveNow(); // a render before the first autosave still gets a record
          const id = get().currentId;
          if (!storage || !id) return null;
          const r = await storage.beginRender(id, fingerprint(useChain.getState().cfg));
          activeRenderId = r.id;
          return r.id;
        };
        renderHooks.end = async (rid, ok, error) => {
          if (storage && rid) await storage.finishRender(rid, ok ? "done" : "failed", ok ? null : (error ?? "failed"));
          if (rid === activeRenderId) activeRenderId = null;
        };

        useChain.subscribe((s, prev) => {
          if (restoring) return;
          if (s.source !== prev.source) set({ currentId: null }); // a new source starts a new session
          if (!s.source || !s.analysis) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void get().saveNow(), s.cfg.storage.autosaveDebounceMs);
        });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e), ready: false });
      }
    })();
    return initPromise;
  },

  async saveNow() {
    if (!storage) return;
    const c = useChain.getState();
    const snap = snapshot();
    if (!snap || !c.source || !c.analysis) return;
    const fp = fingerprint({ id: get().currentId, ...snap });
    if (fp === lastFingerprint && get().currentId) return; // nothing changed since the last save
    try {
      const now = Date.now();
      let id = get().currentId;
      let audio;
      let existing: SessionRecord | undefined;
      if (id) existing = await storage.getSession(id);
      if (!id || !existing) {
        id = crypto.randomUUID();
        audio = { id: `audio-${id}`, sampleRate: c.analysis.sampleRate, length: c.analysis.prepared.length, channels: [c.analysis.prepared] };
      }
      const rec: SessionRecord = {
        schemaVersion: SCHEMA_VERSION,
        id,
        name: c.source.name,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        audioId: existing?.audioId ?? `audio-${id}`,
        source: existing?.source ?? {
          originalName: c.source.name,
          sampleRate: c.analysis.sampleRate,
          channels: 1,
          durationSec: c.analysis.prepared.length / c.analysis.sampleRate,
        },
        ...snap,
      };
      await storage.saveSession(rec, audio);
      lastFingerprint = fingerprint({ id, ...snap });
      const est = await storageEstimate();
      set({ currentId: id, lastSavedAt: now, sessions: await storage.listSessions(), error: null, usage: est ? { usage: est.usage, quota: est.quota } : get().usage });
    } catch (e) {
      set({ error: `Could not save the session: ${e instanceof Error ? e.message : String(e)}` });
    }
  },

  async openSession(id) {
    if (!storage) return;
    const rec = await storage.getSession(id);
    const audio = rec ? await storage.loadAudio(rec.audioId) : undefined;
    if (!rec || !audio) {
      set({ error: "That session's data is missing (it may have been evicted by the browser)." });
      return;
    }
    restoring = true;
    set({ currentId: id, error: null });
    try {
      await useChain.getState().restore(rec, audio);
      lastFingerprint = fingerprint({ id, ...snapshot()! });
    } catch (e) {
      set({ error: `Could not open the session: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      restoring = false;
    }
  },

  async removeSession(id) {
    if (!storage) return;
    await storage.deleteSession(id);
    if (get().currentId === id) set({ currentId: null });
    set({ sessions: await storage.listSessions() });
  },

  /**
   * "Resume" = restart from saved state. A render in an OfflineAudioContext / worker pipeline cannot be checkpointed mid-run,
   * so we reload the saved source PCM + full config + decisions and run the WHOLE render again.
   */
  async resumeInterrupted() {
    const stuck = get().interrupted;
    if (!stuck || !storage) return;
    await storage.finishRender(stuck.render.id, "failed", "interrupted; re-run from saved state");
    set({ interrupted: null });
    await get().openSession(stuck.render.sessionId);
    if (useChain.getState().popDecision !== "pending") await useChain.getState().render();
  },

  async dismissInterrupted() {
    const stuck = get().interrupted;
    if (stuck && storage) await storage.finishRender(stuck.render.id, "failed", "dismissed by user");
    set({ interrupted: null });
  },
}));
