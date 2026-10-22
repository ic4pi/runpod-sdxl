// Generates the PWA icons (PNG, no dependencies): dark rounded tile with an emerald waveform.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x / size, y / size); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const BG = [10, 10, 10], TILE = [23, 23, 23], GREEN = [16, 185, 129];
const bars = [0.18, 0.34, 0.58, 0.82, 0.58, 0.4, 0.66, 0.3, 0.16];
// `inset`: fraction of the canvas the artwork occupies (maskable icons keep it inside the 80% safe zone)
function art({ rounded, inset, opaqueBg }) {
  return (u, v) => {
    let bg = opaqueBg ? TILE : BG, alpha = opaqueBg ? 255 : 0;
    if (!opaqueBg) { // rounded square tile on transparent
      const r = 0.2, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
      if (Math.hypot(u - cx, v - cy) <= r) { bg = TILE; alpha = 255; }
    }
    if (alpha === 0) return [0, 0, 0, 0];
    const x = (u - 0.5) / inset, y = (v - 0.5) / inset; // artwork space -0.5..0.5
    const n = bars.length, w = 1 / (n * 1.7);
    for (let i = 0; i < n; i++) {
      const half = bars[i] * 0.42;
      if (Math.abs(x - (-0.4 + (i / (n - 1)) * 0.8)) < w / 2 && Math.abs(y) < half) return [...GREEN, 255];
    }
    return [...bg, alpha];
  };
}
mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, art({ inset: 0.8, opaqueBg: false })));
writeFileSync("public/icons/icon-512.png", png(512, art({ inset: 0.8, opaqueBg: false })));
writeFileSync("public/icons/icon-maskable-512.png", png(512, art({ inset: 0.56, opaqueBg: true }))); // full-bleed background, artwork inside the safe zone
writeFileSync("public/icons/apple-touch-icon.png", png(180, art({ inset: 0.7, opaqueBg: true }))); // iOS wants an opaque square
console.log("icons written");
