// Real-audio measurement harness. A SCRIPT, not a feature: it changes no behaviour, it only measures what the app already does.
//
//   npm run build
//   npx tsx scripts/measure-real-audio.mjs path/to/real-vocal.wav [--pops skip|apply] [--out measure-out] [--timeout-min 10]
//
// What it does: starts the production build, opens /repair in headless Chromium (the chain needs OfflineAudioContext, so it cannot run in
// plain Node), loads the file (decoded to 48 kHz mono by the app), renders with the NEUTRAL preset (the default), exports WAV and MP3 at
// -14 LUFS through the real Prepare/Save flow, decodes the exported MP3 in Chromium, and measures the INPUT, the exported WAV and the
// decoded MP3 with lib/dsp/measure. It writes the two exports and report.json to --out (default measure-out/, git-ignored).
//
// WHY: Phase 4's MP3 ceiling margin (cfg.export.mp3.ceilingMarginDb, 0.5 dB) was tuned on SYNTHETIC audio. The number that decides
// whether it is enough on real rap is the DECODED MP3's true peak against the ceiling. This prints it, with a verdict.
// Exit code: 0 = ran and margin sufficed, 3 = ran and the MP3 breached the true-peak ceiling (margin too small), 1 = the harness failed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { DEFAULT_CHAIN_CONFIG } from "../lib/dsp/config.ts";
import { parseWav } from "../lib/dsp/fixtures/wav.ts";
import { measureCorrelation } from "../lib/dsp/measure/correlation.ts";
import { measureCrest } from "../lib/dsp/measure/crest.ts";
import { measureLoudness } from "../lib/dsp/measure/loudness.ts";
import { measureTruePeak } from "../lib/dsp/measure/truePeak.ts";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const inputPath = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
if (!inputPath) { console.error("Usage: npx tsx scripts/measure-real-audio.mjs <real-vocal.wav> [--pops skip|apply] [--out dir] [--timeout-min N]"); process.exit(1); }
if (!existsSync(inputPath)) { console.error(`No such file: ${inputPath}`); process.exit(1); }
if (!existsSync(".next/BUILD_ID")) { console.error("Run `npm run build` first."); process.exit(1); }
const POPS = flag("pops", "skip");
const OUT = flag("out", "measure-out");
const TIMEOUT = Number(flag("timeout-min", "10")) * 60_000;
const PORT = process.env.PORT ?? "3143";
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });

const ceilingDbtp = DEFAULT_CHAIN_CONFIG.stages.limiter.params.ceilingDbtp;
const mp3Margin = DEFAULT_CHAIN_CONFIG.export.mp3.ceilingMarginDb;
const TOL = 0.05; // same tolerance the Phase 4 e2e uses for "<= ceiling"

function findChromium() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse())
    for (const sub of readdirSync(path.join(root, d))) { const exe = path.join(root, d, sub, "chrome"); if (existsSync(exe)) return exe; }
  throw new Error("No Chromium found. Set PW_EXE.");
}

// ---------- measurement ----------
const num = (f) => { try { return f(); } catch (e) { return `n/a (${e.code ?? e.message})`; } };
function measureAllOf(pcm) {
  const l = measureLoudness(pcm);
  return {
    seconds: pcm.channels[0].length / pcm.sampleRate,
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.length,
    lufs: l.integrated.value,
    lra: l.lra.value,
    truePeakDbtp: measureTruePeak(pcm).truePeak.value,
    crestDb: measureCrest(pcm).crest.value,
    activeCrestDb: measureCrest(pcm).activeCrest.value,
    lrCorrelation: num(() => measureCorrelation(pcm).correlation.value), // stereo only: exports are mono, so n/a there
  };
}
/** Best lag (samples, MP3 relative to WAV) found on the loudest ~2 s, then Pearson correlation over the whole overlap at that lag. */
function alignedCorrelation(wav, mp3) {
  const n = Math.min(wav.length, mp3.length), win = 96000, maxLag = 4800;
  let best = 0, bestE = -1;
  for (let s = 0; s + win + maxLag < n; s += 24000) { let e = 0; for (let i = s; i < s + win; i += 4) e += wav[i] * wav[i]; if (e > bestE) { bestE = e; best = s; } }
  let lag = 0, bestC = -Infinity;
  for (let L = -maxLag; L <= maxLag; L++) {
    let c = 0; for (let i = best; i < best + win; i += 2) c += wav[i] * (mp3[i + L] ?? 0);
    if (c > bestC) { bestC = c; lag = L; }
  }
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) { const x = wav[i], y = mp3[i + lag]; sxy += x * y; sxx += x * x; syy += y * y; }
  return { lagSamples: lag, correlation: sxy / Math.sqrt(sxx * syy) };
}

// ---------- drive the real app ----------
const server = spawn("npx", ["next", "start", "-p", PORT], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("next start did not start")), 60000);
  server.stdout.on("data", (b) => { if (String(b).includes("Ready")) { clearTimeout(t); resolve(); } });
  server.on("exit", () => reject(new Error("next start exited")));
});

let browser;
try {
  browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 2600 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const waitIdle = () => page.waitForFunction(() => !document.querySelector("[data-testid=busy]"), null, { timeout: TIMEOUT });

  console.log(`loading ${inputPath} into the app...`);
  await page.goto(`${BASE}/repair`, { waitUntil: "load" });
  await page.setInputFiles("[data-testid=file]", inputPath);
  await page.waitForSelector("[data-stage=noisePrint]");
  await page.waitForFunction(() => /Noise print (accepted|rejected)|Print:/.test(document.body.innerText), null, { timeout: TIMEOUT });
  await waitIdle();
  const skip = page.getByRole("button", { name: /Skip de-plosive/ });
  const apply = page.getByRole("button", { name: /Apply to/ });
  if (POPS === "apply" && (await apply.count())) await apply.click();
  else if (await skip.count()) await skip.click();
  await page.waitForFunction(() => { const b = document.querySelector("[data-testid=render]"); return b && !b.disabled; }, null, { timeout: TIMEOUT });
  const preset = (await page.textContent("[data-testid=active-preset]")) ?? "";
  if (!/Neutral/.test(preset)) throw new Error(`expected the Neutral preset to be active, got: ${preset}`);
  console.log("rendering (neutral preset)...");
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => /applied/.test(document.querySelector("[data-stage=limiter]")?.textContent ?? ""), null, { timeout: TIMEOUT });
  await waitIdle();
  await page.fill("[data-testid=meta-artist]", "Measure");
  await page.fill("[data-testid=meta-track]", "Real");

  async function exportFile(fmt) {
    console.log(`exporting ${fmt.toUpperCase()}...`);
    await page.check(`[data-testid=fmt-${fmt}]`);
    await page.click("[data-testid=export-prepare]");
    await page.waitForSelector("[data-testid=export-ready],[data-testid=export-error]", { timeout: TIMEOUT });
    if (await page.$("[data-testid=export-error]")) throw new Error("export error: " + (await page.textContent("[data-testid=export-error]")));
    const status = await page.getAttribute("[data-testid=export-status]", "data-status");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=export-save]")]);
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    return { file, status, bytes: readFileSync(file) };
  }
  const wav = await exportFile("wav");
  const mp3 = await exportFile("mp3");

  console.log("decoding the exported MP3 (Chromium)...");
  const dec = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new AudioContext({ sampleRate: 48000 });
    const ab = await ctx.decodeAudioData(bin.buffer);
    const ch = ab.getChannelData(0);
    await ctx.close();
    let s = ""; const u8 = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength);
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
    return { sr: ab.sampleRate, ch: ab.numberOfChannels, b64: btoa(s) };
  }, mp3.bytes.toString("base64"));
  const mp3Pcm = { sampleRate: dec.sr, channels: [new Float32Array(Buffer.from(dec.b64, "base64").buffer.slice(0))] };
  const wavPcm = parseWav(wav.bytes);

  // input, for context (the app's own decode path is Chromium's; this reads the file directly if it is a WAV encoding parseWav supports)
  let input = null;
  try { input = measureAllOf(parseWav(readFileSync(inputPath))); } catch (e) { input = { note: `input not measured: ${e.message}` }; }
  const w = measureAllOf(wavPcm);
  const m = measureAllOf(mp3Pcm);
  const al = alignedCorrelation(wavPcm.channels[0], mp3Pcm.channels[0]);
  const tpDelta = m.truePeakDbtp - w.truePeakDbtp;
  const breach = m.truePeakDbtp > ceilingDbtp + TOL;

  // ---------- report ----------
  const f = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : String(v));
  const rows = [
    ["", "INPUT (file)", "EXPORT WAV", "EXPORT MP3 (decoded)"],
    ["format", input.note ? "-" : `${input.sampleRate} Hz, ${input.channels} ch`, `${w.sampleRate} Hz, ${w.channels} ch`, `${m.sampleRate} Hz, ${dec.ch} ch`],
    ["seconds", f(input.seconds), f(w.seconds), f(m.seconds)],
    ["LUFS (integrated)", f(input.lufs), f(w.lufs), f(m.lufs)],
    ["true peak (dBTP)", f(input.truePeakDbtp), f(w.truePeakDbtp), f(m.truePeakDbtp)],
    ["LRA (LU)", f(input.lra), f(w.lra), f(m.lra)],
    ["crest (dB)", f(input.crestDb), f(w.crestDb), f(m.crestDb)],
    ["active crest (dB)", f(input.activeCrestDb), f(w.activeCrestDb), f(m.activeCrestDb)],
    ["L/R correlation", f(input.lrCorrelation, 3), "n/a (mono export)", "n/a (mono export)"],
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  console.log("\n" + rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c])).join("  ")).join("\n"));
  console.log(`\nexport status: WAV=${wav.status}  MP3=${mp3.status}   (files in ${OUT}/)`);
  console.log(`MP3 vs WAV: waveform correlation ${f(al.correlation, 4)} at ${al.lagSamples} samples of encoder delay`);
  console.log(`MP3 vs WAV: LUFS delta ${f(m.lufs - w.lufs)} LU, true-peak delta ${f(tpDelta)} dB (decoded MP3 minus WAV)`);
  console.log(`\nTRUE-PEAK CEILING CHECK   ceiling ${ceilingDbtp} dBTP, MP3 limiter ceiling ${ceilingDbtp - mp3Margin} dBTP (margin ${mp3Margin} dB)`);
  console.log(`  decoded MP3 true peak: ${f(m.truePeakDbtp)} dBTP  ->  ${breach ? "BREACH: the MP3 is above the ceiling" : "within the ceiling"}`);
  if (breach) console.log(`  MARGIN TOO SMALL on this file: increase cfg.export.mp3.ceilingMarginDb (now ${mp3Margin}) by at least ${f(m.truePeakDbtp - ceilingDbtp)} dB.`);
  else console.log(`  the ${mp3Margin} dB margin was enough on this file. One file proves little: run several (loud, quiet, clipped, sibilant) before trusting it.`);
  if (tpDelta > mp3Margin) console.log(`  NOTE: the MP3's true peak is ${f(tpDelta)} dB above the WAV's (more than the ${mp3Margin} dB margin). That alone is not a breach (the WAV may simply sit below the ceiling); the breach test above is the one that matters.`);
  if (errors.length) console.log(`\npage errors: ${errors.slice(0, 3).join(" | ")}`);

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ input, wav: w, mp3: m, exportStatus: { wav: wav.status, mp3: mp3.status }, mp3VsWav: { ...al, lufsDelta: m.lufs - w.lufs, truePeakDelta: tpDelta }, ceilingDbtp, mp3Margin, breach, popsDecision: POPS }, null, 2));
  await browser.close();
  stop();
  process.exit(breach ? 3 : 0);
} catch (e) {
  console.error("\nHARNESS FAILED:", e instanceof Error ? e.message : e);
  await browser?.close().catch(() => {});
  stop();
  process.exit(1);
}
