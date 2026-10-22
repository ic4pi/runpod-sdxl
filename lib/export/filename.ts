import type { ChainConfig } from "../dsp/config";

/**
 * Filename: `{artist}_{track}_{preset}.{ext}`. Artist and track come from the metadata form only.
 *
 * SANITIZATION RULE (applied to artist and track; the preset id is already [a-z-]):
 *  1. Unicode NFC.
 *  2. Replace every run of whitespace (incl. tabs/newlines) and "_" with a single "-" (so the "_" field separator stays unambiguous).
 *  3. Remove remaining control characters (U+0000-001F, U+007F-009F) and zero-width/bidi marks (U+200B-200F, U+202A-202E, U+2066-2069).
 *  4. Replace each filesystem-illegal character  \ / : * ? " < > |  and also  %  # &  with "-". (Windows + macOS + URL-hostile.)
 *  5. Collapse repeated "-", then trim "-", "." and spaces from both ends (no leading dots, no trailing dot: Windows).
 *  6. Truncate to `maxFieldChars` Unicode code points (never splitting a surrogate pair).
 *  7. An empty result becomes the configured placeholder (`artist` / `track`).
 *  8. If the UTF-8 length of the whole base name still exceeds `maxBytes`, shorten the longer of artist/track one code point at a time.
 * Case is preserved. Windows reserved device names (CON, NUL, ...) cannot occur because the base name always contains "_" and an extension.
 */
const ILLEGAL = /[\\/:*?"<>|%#&]/g;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export function sanitizeField(raw: string, maxChars: number, fallback: string): string {
  let s = raw.normalize("NFC").replace(/[\s_]+/g, "-").replace(INVISIBLE, "");
  s = s.replace(ILLEGAL, "-").replace(/-{2,}/g, "-");
  s = s.replace(/^[-.\s]+|[-.\s]+$/g, "");
  s = [...s].slice(0, maxChars).join("").replace(/[-.\s]+$/g, "");
  return s === "" ? fallback : s;
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

export function buildFilename(
  parts: { artist: string; track: string; presetId: string; ext: "wav" | "mp3" },
  cfg: ChainConfig["export"]["filename"],
): string {
  let artist = sanitizeField(parts.artist, cfg.maxFieldChars, cfg.emptyArtist);
  let track = sanitizeField(parts.track, cfg.maxFieldChars, cfg.emptyTrack);
  const base = () => [artist, track, parts.presetId].join(cfg.separator);
  while (utf8Len(base()) > cfg.maxBytes && (artist.length > 1 || track.length > 1)) {
    if ([...artist].length >= [...track].length) artist = [...artist].slice(0, -1).join("").replace(/[-.\s]+$/g, "") || cfg.emptyArtist.slice(0, 1);
    else track = [...track].slice(0, -1).join("").replace(/[-.\s]+$/g, "") || cfg.emptyTrack.slice(0, 1);
  }
  return `${base()}.${parts.ext}`;
}
