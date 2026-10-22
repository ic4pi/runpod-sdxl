/** IndexedDB tests (fake-indexeddb implements real IDB semantics incl. structured clone). AUDIO IS SYNTHETIC (generated tones/noise/vocal). */
import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAIN_CONFIG } from "../lib/dsp/config";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { configForPreset } from "../lib/presets";
import { fingerprint, openStorage, SCHEMA_VERSION, type SessionRecord, type StoredAudio } from "../lib/storage/idb";
import { noise, SR, sine } from "./helpers";

const sha = (a: Float32Array) => createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex");

function session(id: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: `${id}.wav`,
    createdAt: 1_000,
    updatedAt: 1_000,
    audioId: `audio-${id}`,
    source: { originalName: `${id}.wav`, sampleRate: 44100, channels: 2, durationSec: 5 },
    presetId: "trap",
    config: configForPreset("trap"),
    bypass: { deess: true, space: false },
    printStartSec: 1.25,
    pops: { decision: "confirmed", confirmedIds: [0, 2, 5] },
    metadata: { artist: "Lil Test", track: "Take 1" },
    exportFormat: "mp3",
    ...over,
  };
}
const audioFor = (id: string, channels: Float32Array[], sampleRate = SR): StoredAudio => ({ id: `audio-${id}`, sampleRate, length: channels[0]!.length, channels });
const open = (factory: IDBFactory, maxSessions = 5) => openStorage({ factory, name: "t", maxSessions });

describe("IndexedDB round trip of the actual Float32 samples (SYNTHETIC audio, byte-exact)", () => {
  it("mono 48 kHz vocal + noise survives close/reopen bit for bit", async () => {
    const factory = new IDBFactory();
    const vocal = generateSyntheticVocal({ seed: 4, f0Base: 130 }).channels[0]!; // 14 s
    const hiss = noise(0.001, 14, 3);
    const mixed = Float32Array.from(vocal, (v, i) => v + hiss[i]!);
    const before = sha(mixed);

    const a = await open(factory);
    await a.saveSession(session("s1"), audioFor("s1", [mixed]));
    a.close();

    const b = await open(factory); // a brand new connection: nothing cached in memory
    const got = await b.loadAudio("audio-s1");
    expect(got).toBeDefined();
    expect(got!.sampleRate).toBe(SR);
    expect(got!.length).toBe(mixed.length);
    expect(got!.channels).toHaveLength(1);
    expect(got!.channels[0]).toBeInstanceOf(Float32Array);
    expect(sha(got!.channels[0]!)).toBe(before);
    expect(Buffer.compare(Buffer.from(got!.channels[0]!.buffer), Buffer.from(mixed.buffer))).toBe(0);
    expect(got!.channels[0]).not.toBe(mixed); // a copy, not the same object
    b.close();
  });

  it("stereo 44.1 kHz keeps both channels distinct and the sample rate", async () => {
    const factory = new IDBFactory();
    const l = sine(440, 0.4, 3, 44100);
    const r = sine(660, 0.3, 3, 44100);
    const s = await open(factory);
    await s.saveSession(session("st"), audioFor("st", [l, r], 44100));
    const got = await s.loadAudio("audio-st");
    expect(got!.sampleRate).toBe(44100);
    expect(sha(got!.channels[0]!)).toBe(sha(l));
    expect(sha(got!.channels[1]!)).toBe(sha(r));
    expect(sha(got!.channels[0]!)).not.toBe(sha(got!.channels[1]!));
  });

  it("special float values survive exactly (0, -0, tiny denormals, +-1)", async () => {
    const factory = new IDBFactory();
    const odd = Float32Array.from([0, -0, 1e-45, -1e-45, 1, -1, 0.1, 1 / 3]);
    const s = await open(factory);
    await s.saveSession(session("odd"), audioFor("odd", [odd]));
    const got = (await s.loadAudio("audio-odd"))!.channels[0]!;
    expect(Array.from(got).map((v) => Object.is(v, -0))).toEqual(Array.from(odd).map((v) => Object.is(v, -0)));
    expect(sha(got)).toBe(sha(odd));
  });

  it("a minute of mono 48 kHz (11.5 MB) round-trips", async () => {
    const factory = new IDBFactory();
    const long = noise(0.1, 60, 8);
    const s = await open(factory);
    await s.saveSession(session("long"), audioFor("long", [long]));
    expect(sha((await s.loadAudio("audio-long"))!.channels[0]!)).toBe(sha(long));
  }, 60000);
});

describe("sessions", () => {
  it("the full session record (incl. the whole resolved config, bypass map, pop decisions, metadata) round-trips exactly", async () => {
    const factory = new IDBFactory();
    const rec = session("full");
    const s = await open(factory);
    await s.saveSession(rec, audioFor("full", [sine(300, 0.2, 1)]));
    s.close();
    const got = await (await open(factory)).getSession("full");
    expect(got).toEqual(rec);
    expect(got!.config).toEqual(configForPreset("trap"));
    expect(got!.config).not.toEqual(DEFAULT_CHAIN_CONFIG);
  });

  it("list is newest-first, light (no audio), and reports size", async () => {
    const factory = new IDBFactory();
    const s = await open(factory);
    await s.saveSession(session("old", { updatedAt: 10 }), audioFor("old", [sine(300, 0.2, 1)]));
    await s.saveSession(session("new", { updatedAt: 20 }), audioFor("new", [sine(300, 0.2, 1)]));
    const list = await s.listSessions();
    expect(list.map((x) => x.id)).toEqual(["new", "old"]);
    expect(list[0]!.bytes).toBe(5 * 44100 * 4);
  });

  it("updating a session without re-sending audio keeps the audio", async () => {
    const factory = new IDBFactory();
    const s = await open(factory);
    const x = sine(300, 0.2, 1);
    await s.saveSession(session("u"), audioFor("u", [x]));
    await s.saveSession(session("u", { presetId: "drill", updatedAt: 5000 }));
    expect((await s.getSession("u"))!.presetId).toBe("drill");
    expect(sha((await s.loadAudio("audio-u"))!.channels[0]!)).toBe(sha(x));
  });

  it("delete removes the session, its audio and its render records", async () => {
    const factory = new IDBFactory();
    const s = await open(factory);
    await s.saveSession(session("d"), audioFor("d", [sine(300, 0.2, 1)]));
    await s.beginRender("d", "abc");
    await s.deleteSession("d");
    expect(await s.getSession("d")).toBeUndefined();
    expect(await s.loadAudio("audio-d")).toBeUndefined();
    expect(await s.findInterruptedRenders()).toEqual([]);
  });

  it("keeps at most maxSessions: the oldest (with its audio) is evicted, the one just saved never is", async () => {
    const factory = new IDBFactory();
    const s = await open(factory, 2);
    await s.saveSession(session("a", { updatedAt: 1 }), audioFor("a", [sine(300, 0.2, 1)]));
    await s.saveSession(session("b", { updatedAt: 2 }), audioFor("b", [sine(300, 0.2, 1)]));
    const r = await s.saveSession(session("c", { updatedAt: 3 }), audioFor("c", [sine(300, 0.2, 1)]));
    expect(r.evicted).toEqual(["a"]);
    expect((await s.listSessions()).map((x) => x.id)).toEqual(["c", "b"]);
    expect(await s.loadAudio("audio-a")).toBeUndefined();
    // saving an OLD timestamp still keeps the just-saved session
    const r2 = await s.saveSession(session("z", { updatedAt: 0 }), audioFor("z", [sine(300, 0.2, 1)]));
    expect(r2.evicted).not.toContain("z");
    expect(await s.getSession("z")).toBeDefined();
  });

  it("the session and its audio are written in one transaction (a bad audio id writes nothing)", async () => {
    const factory = new IDBFactory();
    const s = await open(factory);
    await expect(s.saveSession(session("tx"), { ...audioFor("tx", [sine(300, 0.2, 1)]), id: "wrong" })).rejects.toThrow(/audio.id/);
    expect(await s.getSession("tx")).toBeUndefined();
  });
});

describe("interrupted renders and settings", () => {
  it("a render that never finished is found after a 'crash' (new connection); a finished one is not", async () => {
    const factory = new IDBFactory();
    const a = await open(factory);
    const fp = fingerprint(configForPreset("trap"));
    const r1 = await a.beginRender("s1", fp);
    const r2 = await a.beginRender("s2", fp);
    await a.finishRender(r2.id, "done");
    a.close(); // page killed mid-render of s1
    const b = await open(factory);
    const stuck = await b.findInterruptedRenders();
    expect(stuck.map((r) => r.id)).toEqual([r1.id]);
    expect(stuck[0]).toMatchObject({ status: "running", finishedAt: null, sessionId: "s1", configFingerprint: fp });
    await b.finishRender(r1.id, "failed", "dismissed");
    expect(await b.findInterruptedRenders()).toEqual([]);
  });

  it("fingerprint is stable and changes when the config changes", () => {
    expect(fingerprint(configForPreset("trap"))).toBe(fingerprint(configForPreset("trap")));
    expect(fingerprint(configForPreset("trap"))).not.toBe(fingerprint(configForPreset("drill")));
  });

  it("settings: default when absent, persisted when set, across connections", async () => {
    const factory = new IDBFactory();
    const a = await open(factory);
    expect(await a.getSetting("exportFormat", "wav")).toBe("wav");
    await a.setSetting("exportFormat", "mp3");
    await a.setSetting("lastArtist", { name: "x" });
    a.close();
    const b = await open(factory);
    expect(await b.getSetting("exportFormat", "wav")).toBe("mp3");
    expect(await b.getSetting("lastArtist", null)).toEqual({ name: "x" });
  });

  it("without IndexedDB, opening fails loudly", async () => {
    await expect(openStorage({ factory: undefined, maxSessions: 1, name: "x" })).rejects.toThrow(/IndexedDB is not available/);
  });
});

describe("generic response cache (v2 store)", () => {
  it("round-trips JSON across connections and trims to the newest N entries", async () => {
    const factory = new IDBFactory();
    const a = await open(factory);
    expect(await a.getCached("k")).toBeUndefined();
    for (let i = 0; i < 5; i++) {
      await a.putCached(`k${i}`, { n: i, nested: { x: [1, 2, 3] } }, 3);
      await new Promise((r) => setTimeout(r, 3)); // distinct storedAt
    }
    a.close();
    const b = await open(factory);
    expect(await b.getCached("k4")).toEqual({ n: 4, nested: { x: [1, 2, 3] } });
    expect(await b.getCached("k2")).toBeDefined();
    expect(await b.getCached("k1")).toBeUndefined(); // trimmed
    expect(await b.getCached("k0")).toBeUndefined();
  });

  it("a database created at version 1 upgrades to 2 without losing sessions", async () => {
    const factory = new IDBFactory();
    // simulate the Phase 4 (v1) database
    await new Promise<void>((resolve, reject) => {
      const r = factory.open("t", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        db.createObjectStore("audio", { keyPath: "id" });
        db.createObjectStore("settings", { keyPath: "key" });
        db.createObjectStore("renders", { keyPath: "id" }).createIndex("sessionId", "sessionId");
      };
      r.onsuccess = () => {
        const tx = r.result.transaction("sessions", "readwrite");
        tx.objectStore("sessions").put(session("old-v1"));
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
      r.onerror = () => reject(r.error);
    });
    const s = await open(factory);
    expect((await s.getSession("old-v1"))!.id).toBe("old-v1");
    await s.putCached("x", { ok: true }, 5);
    expect(await s.getCached("x")).toEqual({ ok: true });
  });
});
