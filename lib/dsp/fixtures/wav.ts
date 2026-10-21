import type { Pcm } from "../measure/types";

/**
 * Minimal WAV reader/writer (RIFF/WAVE). Reads 8/16/24/32-bit PCM and 32/64-bit float, mono or multichannel
 * (incl. WAVE_FORMAT_EXTENSIBLE). Anything else throws with an explicit message; it never guesses.
 */
export function parseWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a RIFF/WAVE file.");

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  for (let o = 12; o + 8 <= bytes.byteLength; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const rate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // extensible: sub-format GUID's first 2 bytes
      fmt = { format, channels, rate, bits };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, bytes.byteLength - body);
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error("WAV has no fmt chunk.");
  if (dataOff < 0) throw new Error("WAV has no data chunk.");
  const { format, channels, rate, bits } = fmt;
  if (channels < 1) throw new Error("WAV reports zero channels.");
  const isPcm = format === 1;
  const isFloat = format === 3;
  if (!(isPcm && [8, 16, 24, 32].includes(bits)) && !(isFloat && [32, 64].includes(bits))) {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). Use 16/24/32-bit PCM or 32-bit float WAV.`);
  }
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bytesPer;
      let s: number;
      if (isFloat) s = bits === 32 ? v.getFloat32(o, true) : v.getFloat64(o, true);
      else if (bits === 8) s = (v.getUint8(o) - 128) / 128;
      else if (bits === 16) s = v.getInt16(o, true) / 32768;
      else if (bits === 24) s = (((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) >> 8) / 8388608;
      else s = v.getInt32(o, true) / 2147483648;
      out[c]![i] = s;
    }
  }
  return { sampleRate: rate, channels: out };
}

/** Encode as 16-bit PCM (default) or 32-bit float WAV. */
export function encodeWav(pcm: Pcm, bits: 16 | 32 = 16): Uint8Array<ArrayBuffer> {
  const ch = pcm.channels.length;
  const frames = pcm.channels[0]!.length;
  const bytesPer = bits / 8;
  const dataLen = frames * ch * bytesPer;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * ch * bytesPer, true);
  v.setUint16(32, ch * bytesPer, true);
  v.setUint16(34, bits, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const x = pcm.channels[c]![i]!;
      if (bits === 32) v.setFloat32(o, x, true);
      else v.setInt16(o, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true);
      o += bytesPer;
    }
  }
  return new Uint8Array(buf);
}
