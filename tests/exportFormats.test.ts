/** WAV / MP3 / filename tests. AUDIO IS SYNTHETIC (generated tones); no real recordings. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parseWav } from "../lib/dsp/fixtures/wav";
import { buildFilename, sanitizeField } from "../lib/export/filename";
import { encodeMonoWav } from "../lib/export/wav";
import { cfgCopy, SR, sine } from "./helpers";

const cfg = cfgCopy();
const root = path.join(__dirname, "..");

describe("WAV", () => {
  const x = sine(1000, 0.5, 1);
  it("writes a mono 48 kHz 16-bit header and round-trips within 2 LSB with TPDF dither", () => {
    const bytes = encodeMonoWav(x, SR, cfg.export.wav);
    const v = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    const back = parseWav(bytes);
    expect(back.channels).toHaveLength(1);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(back.channels[0]![i]! - x[i]!));
    expect(worst).toBeLessThanOrEqual(2 / 32768);
  });
  it("dither is seeded (same bytes every time) and can be turned off (then error <= half an LSB)", () => {
    expect(Buffer.from(encodeMonoWav(x, SR, cfg.export.wav)).equals(Buffer.from(encodeMonoWav(x, SR, cfg.export.wav)))).toBe(true);
    const plain = parseWav(encodeMonoWav(x, SR, { ...cfg.export.wav, dither: false })).channels[0]!;
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(plain[i]! - x[i]!));
    expect(worst).toBeLessThanOrEqual(1.1 / 32768); // half an LSB of rounding + the 32767-vs-32768 scale convention
  });
  it("32-bit float is exact, and out-of-range samples clamp instead of wrapping", () => {
    expect(Array.from(parseWav(encodeMonoWav(x, SR, { ...cfg.export.wav, bitDepth: 32 })).channels[0]!)).toEqual(Array.from(x));
    const loud = Float32Array.from([1.5, -1.5, 0.2]);
    const back = parseWav(encodeMonoWav(loud, SR, { ...cfg.export.wav, dither: false })).channels[0]!;
    expect(back[0]).toBeGreaterThan(0.99);
    expect(back[1]).toBeLessThan(-0.99);
  });
});

describe("MP3: the SHIPPED worker + the SHIPPED lamejs file, run in a sandbox", () => {
  const lameSrc = readFileSync(path.join(root, "public/vendor/lamejs/lame.all.js"), "utf8");
  const workerSrc = readFileSync(path.join(root, "public/workers/mp3-worker.js"), "utf8");

  function encode(pcm: Float32Array): Uint8Array {
    const sandbox: Record<string, unknown> = {};
    sandbox.self = sandbox;
    sandbox.importScripts = (url: string) => {
      expect(url).toBe("/vendor/lamejs/lame.all.js"); // the worker loads the encoder from its own separate file
      vm.runInContext(lameSrc, ctx);
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(workerSrc, ctx);
    const e = cfg.export.mp3;
    const out = (sandbox.encodeMp3 as (...a: unknown[]) => ArrayLike<number>)(sandbox.lamejs, pcm, SR, e.bitrateKbps, e.chunkSamples);
    return Uint8Array.from(out);
  }

  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  it("produces a valid MPEG-1 Layer III mono 48 kHz stream at the configured bitrate (every frame header parses)", () => {
    const mp3 = encode(sine(1000, 0.5, 3));
    let pos = 0;
    let frames = 0;
    while (pos + 4 <= mp3.length) {
      const h = (mp3[pos]! << 24) | (mp3[pos + 1]! << 16) | (mp3[pos + 2]! << 8) | mp3[pos + 3]!;
      expect((h >>> 21) & 0x7ff, `sync at ${pos}`).toBe(0x7ff);
      expect((h >>> 19) & 3).toBe(3); // MPEG-1
      expect((h >>> 17) & 3).toBe(1); // Layer III
      const bitrate = BITRATES[(h >>> 12) & 15]!;
      expect(bitrate).toBe(cfg.export.mp3.bitrateKbps);
      expect((h >>> 10) & 3).toBe(1); // 48 kHz
      expect((h >>> 6) & 3).toBe(3); // mono
      const pad = (h >>> 9) & 1;
      pos += Math.floor((144 * bitrate * 1000) / 48000) + pad;
      frames++;
    }
    expect(pos).toBe(mp3.length); // frames tile the whole file exactly
    expect(frames).toBeGreaterThanOrEqual(Math.floor((3 * SR) / cfg.export.mp3.chunkSamples));
    expect(frames).toBeLessThanOrEqual(Math.ceil((3 * SR) / cfg.export.mp3.chunkSamples) + 3);
  });

  it("the vendored encoder is byte-identical to the npm package it claims to be (lamejs@1.2.1, unmodified)", () => {
    const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");
    expect(sha("public/vendor/lamejs/lame.all.js")).toBe(sha("node_modules/lamejs/lame.all.js"));
    expect(JSON.parse(readFileSync(path.join(root, "node_modules/lamejs/package.json"), "utf8"))).toMatchObject({ version: "1.2.1", license: "LGPL-3.0" });
  });

  it("license texts and notices ship with the app", () => {
    for (const f of ["LGPL-3.0.txt", "GPL-3.0.txt", "lamejs-LICENSE.txt", "rnnoise-BSD-3-Clause.txt", "jitsi-rnnoise-wasm-Apache-2.0.txt"]) {
      expect(readFileSync(path.join(root, "public/licenses", f), "utf8").length, f).toBeGreaterThan(300);
    }
    expect(readFileSync(path.join(root, "public/licenses/LGPL-3.0.txt"), "utf8")).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/);
  });
});

describe("filename: {artist}_{track}_{preset}.{ext}", () => {
  const f = (artist: string, track: string, ext: "wav" | "mp3" = "wav") => buildFilename({ artist, track, presetId: "trap", ext }, cfg.export.filename);
  it("plain names", () => {
    expect(f("Lil Test", "First Take")).toBe("Lil-Test_First-Take_trap.wav");
    expect(f("A", "B", "mp3")).toBe("A_B_trap.mp3");
  });
  it("illegal characters, separators and whitespace", () => {
    expect(f('AC/DC', 'Back: In "Black"?')).toBe("AC-DC_Back-In-Black_trap.wav");
    expect(f("a_b", "c  d\te")).toBe("a-b_c-d-e_trap.wav");
    expect(f("<>|*\\", "%#&")).toBe("artist_track_trap.wav"); // nothing left -> placeholders
  });
  it("control characters, leading dots and trailing dots/spaces", () => {
    expect(f("\u0000‮foo​", "..hidden. ")).toBe("foo_hidden_trap.wav");
    expect(f("   ", "")).toBe("artist_track_trap.wav");
  });
  it("Unicode is kept (NFC), emoji truncation never splits a surrogate pair", () => {
    expect(f("Beyoncé", "Café")).toBe("Beyoncé_Café_trap.wav");
    expect(f("é", "x")).toBe("é_x_trap.wav"); // decomposed -> composed
    const long = "😀".repeat(80);
    expect([...sanitizeField(long, 60, "x")]).toHaveLength(60);
    expect(sanitizeField(long, 60, "x")).not.toMatch(/�/);
  });
  it("a long name is cut to fit the byte cap", () => {
    const name = f("😀".repeat(70), "界".repeat(70));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(cfg.export.filename.maxBytes + ".wav".length);
    expect(name.endsWith("_trap.wav")).toBe(true);
  });
  it("result never contains a filesystem-illegal character", () => {
    const nasty = 'a\\/:*?"<>|%#&\u0001b';
    expect(f(nasty, nasty)).not.toMatch(/[\\/:*?"<>|%#&\u0000-\u001f]/);
  });
});
