// Independent check of an exported file with the Phase 1 measurement functions. Usage: tsx scripts/measure-wav.ts file.wav
import { readFileSync } from "node:fs";
import { parseWav } from "../lib/dsp/fixtures/wav";
import { measureLoudness } from "../lib/dsp/measure/loudness";
import { measureTruePeak } from "../lib/dsp/measure/truePeak";

const pcm = parseWav(readFileSync(process.argv[2]!));
const l = measureLoudness(pcm);
const t = measureTruePeak(pcm);
console.log(JSON.stringify({ sampleRate: pcm.sampleRate, channels: pcm.channels.length, seconds: pcm.channels[0]!.length / pcm.sampleRate, lufs: l.integrated.value, lra: l.lra.value, truePeakDbtp: t.truePeak.value }));
