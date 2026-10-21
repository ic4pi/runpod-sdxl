import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseWav } from "./wav";
import type { Pcm } from "../measure/types";

/** Node-only. Real recordings dropped into /fixtures/audio (see fixtures/audio/README.md). */
export const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "audio");
export const FIXTURE_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".caf", ".webm", ".mp4"] as const;

export function listFixtures(dir: string = FIXTURE_DIR): string[] {
  try {
    return readdirSync(/*turbopackIgnore: true*/ dir)
      .filter((f) => FIXTURE_EXTENSIONS.some((e) => f.toLowerCase().endsWith(e)))
      .sort();
  } catch {
    return [];
  }
}

export interface LoadedFixture {
  name: string;
  /** Present for WAV. Other formats are decoded by the browser only (decodeAudioData). */
  pcm: Pcm | null;
  skipReason: string | null;
}

export function loadFixtures(dir: string = FIXTURE_DIR): LoadedFixture[] {
  return listFixtures(dir).map((name) => {
    if (!name.toLowerCase().endsWith(".wav")) {
      return { name, pcm: null, skipReason: "not WAV: decoded in the browser UI only" };
    }
    try {
      return { name, pcm: parseWav(readFileSync(/*turbopackIgnore: true*/ path.join(dir, name))), skipReason: null };
    } catch (e) {
      return { name, pcm: null, skipReason: e instanceof Error ? e.message : String(e) };
    }
  });
}
