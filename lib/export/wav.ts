import type { ChainConfig } from "../dsp/config";
import { makeRng } from "../dsp/rng";

/** Mono WAV: 16-bit PCM (optionally TPDF-dithered, seeded so it is reproducible) or 32-bit float. */
export function encodeMonoWav(x: Float32Array, sampleRate: number, cfg: ChainConfig["export"]["wav"]): Uint8Array<ArrayBuffer> {
  const bits = cfg.bitDepth;
  const bytesPer = bits / 8;
  const dataLen = x.length * bytesPer;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPer, true);
  v.setUint16(32, bytesPer, true);
  v.setUint16(34, bits, true);
  tag(36, "data");
  v.setUint32(40, dataLen, true);
  const rng = makeRng(cfg.ditherSeed);
  const full = 32767; // int16 positive full scale
  for (let i = 0; i < x.length; i++) {
    const o = 44 + i * bytesPer;
    if (bits === 32) v.setFloat32(o, x[i]!, true);
    else {
      // TPDF dither: difference of two uniforms, +-1 LSB, decorrelates quantisation error
      const d = cfg.dither ? rng() - rng() : 0;
      const q = Math.round(x[i]! * full + d);
      v.setInt16(o, Math.max(-full - 1, Math.min(full, q)), true);
    }
  }
  return new Uint8Array(buf);
}
