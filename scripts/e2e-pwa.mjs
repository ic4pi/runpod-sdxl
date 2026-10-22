// Real-browser PWA + export + persistence verification against the PRODUCTION build.
// Usage: npm run build && npm run e2e:pwa
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = process.env.PORT ?? "3141";
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.E2E_OUT ?? "e2e-out";
mkdirSync(OUT, { recursive: true });
if (!existsSync(".next/BUILD_ID") || !existsSync("public/precache-manifest.js")) throw new Error("Run `npm run build` first.");

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
function findChromium() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse())
    for (const sub of readdirSync(path.join(root, d))) { const exe = path.join(root, d, sub, "chrome"); if (existsSync(exe)) return exe; }
  throw new Error("No Chromium found. Set PW_EXE.");
}
const measure = (file) => JSON.parse(execFileSync("npx", ["tsx", "scripts/measure-wav.ts", file], { encoding: "utf8" }).trim().split("\n").pop());

// ---- synthetic input (generated here; no real recording): 44.1 kHz STEREO 16-bit, 12 s: room tone, then voiced syllables with plosive-like thumps
function makeInputWav() {
  const sr = 44100, n = sr * 12;
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const x = new Float32Array(n); let lp = 0;
  for (let i = 0; i < n; i++) { lp += 0.35 * ((rnd() * 2 - 1) - lp); x[i] = lp * 0.0035; }
  for (let s = 0, t = 2.7; t < 11.4; s++, t += 0.31) {
    const f0 = 120 + 40 * ((s * 37) % 5) / 4, a = Math.floor(t * sr), len = Math.floor(0.2 * sr);
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / (0.015 * sr), (len - i) / (0.04 * sr));
      let v = 0; for (let h = 1; h < 30; h++) { const f = h * f0; v += Math.sin(2 * Math.PI * f * i / sr) / h * (1 / (1 + ((f - 700) / 90) ** 2) + 0.6 / (1 + ((f - 1200) / 140) ** 2)); }
      x[a + i] += 0.45 * env * v;
    }
  }
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < n; i++) x[i] *= 0.5 / pk;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const l = Math.round(x[i] * 32767), r = Math.round(x[i] * 0.9 * 32767); buf.writeInt16LE(l, 44 + i * 4); buf.writeInt16LE(r, 46 + i * 4); }
  return buf;
}
const inputPath = path.join(OUT, "input.wav");
writeFileSync(inputPath, makeInputWav());

const server = spawn("npx", ["next", "start", "-p", PORT], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("next start did not start")), 60000);
  server.stdout.on("data", (b) => { if (String(b).includes("Ready")) { clearTimeout(t); resolve(); } });
  server.on("exit", () => reject(new Error("next start exited")));
});

const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + detail : ""}`); };
// A persistent profile (not Playwright's default incognito-like context): Chrome refuses installability in incognito.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), "vr-e2e-")), { executablePath: findChromium(), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], viewport: { width: 1100, height: 2600 }, acceptDownloads: true });
const browser = context;
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const failedReqs = [];
page.on("requestfailed", (r) => { if (!/favicon/.test(r.url())) failedReqs.push(`${r.url()} ${r.failure()?.errorText}`); });

const waitIdle = () => page.waitForFunction(() => !document.querySelector("[data-testid=busy]"), null, { timeout: 120000 });
const stageStatus = async (id) => (await page.textContent(`[data-stage=${id}]`)) ?? "";
async function loadInputAndRender() {
  await page.setInputFiles("[data-testid=file]", inputPath);
  await page.waitForSelector("[data-stage=noisePrint]", { timeout: 60000 });
  await page.waitForFunction(() => /Noise print (accepted|rejected)|Print:/.test(document.body.innerText), null, { timeout: 90000 });
  await waitIdle();
  const skip = page.getByRole("button", { name: /Skip de-plosive/ });
  if (await skip.count()) await skip.click();
  await page.waitForFunction(() => { const b = document.querySelector("[data-testid=render]"); return b && !b.disabled; }, null, { timeout: 60000 });
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => /applied/.test(document.querySelector("[data-stage=limiter]")?.textContent ?? ""), null, { timeout: 120000 });
  await waitIdle();
}
async function exportFile(fmt, label) {
  await page.check(`[data-testid=fmt-${fmt}]`);
  await page.click("[data-testid=export-prepare]");
  await page.waitForSelector("[data-testid=export-ready],[data-testid=export-error]", { timeout: 120000 });
  if (await page.$("[data-testid=export-error]")) throw new Error("export error: " + (await page.textContent("[data-testid=export-error]")));
  const status = await page.getAttribute("[data-testid=export-status]", "data-status");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=export-save]")]);
  const file = path.join(OUT, `${label}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename(), status, bytes: readFileSync(file) };
}

try {
  // ================= A. installability + service worker + precache (online) =================
  await page.goto(`${BASE}/repair`, { waitUntil: "load" });
  await page.waitForSelector("[data-testid=offline-ready]", { timeout: 60000 });
  const ready = await page.textContent("[data-testid=offline-ready]");
  check("service worker active; page reports offline-ready", /Works offline/.test(ready ?? ""), ready ?? "");
  const manifestUrl = await page.getAttribute("link[rel=manifest]", "href");
  check("page links a manifest", manifestUrl === "/manifest.json", String(manifestUrl));
  const manifest = await (await page.request.get(`${BASE}/manifest.json`)).json();
  check("manifest: name, start_url, standalone, 192+512 icons, a maskable icon", manifest.name && manifest.start_url && manifest.display === "standalone" && manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512") && manifest.icons.some((i) => i.purpose === "maskable"), `${manifest.name}, ${manifest.display}, ${manifest.icons.length} icons`);
  for (const i of manifest.icons) { const r = await page.request.get(BASE + i.src); check(`icon ${i.src} loads as PNG`, r.ok() && /image\/png/.test(r.headers()["content-type"] ?? ""), String(r.status())); }
  const cdp = await context.newCDPSession(page);
  await cdp.send("Page.enable");
  const inst = await cdp.send("Page.getInstallabilityErrors");
  check("Chrome installability check (CDP Page.getInstallabilityErrors) reports NO errors", inst.installabilityErrors.length === 0, JSON.stringify(inst.installabilityErrors));
  const am = await cdp.send("Page.getAppManifest");
  check("Chrome parsed the manifest without errors", (am.errors ?? []).length === 0 && !!am.data, JSON.stringify(am.errors ?? []));
  await page.waitForTimeout(2500);
  const bip = await page.evaluate(() => window.__bipFired === true || !!document.querySelector("[data-testid=install-button]"));
  console.log(`   (info) beforeinstallprompt fired / Install button shown in headless Chromium: ${bip}`);

  const cacheInfo = await page.evaluate(async () => {
    const keys = await caches.keys(); const name = keys.find((k) => k.startsWith("vr-precache-")); const c = await caches.open(name);
    const reqs = (await c.keys()).map((r) => new URL(r.url).pathname);
    const html = await (await c.match("/repair")).text();
    const assets = [...new Set([...html.matchAll(/["'(=]\s*(\/_next\/static\/[^"'\s)<>\\]+)/g)].map((m) => m[1].split("?")[0]))];
    return { name, count: reqs.length, wasm: reqs.includes("/wasm/rnnoise.wasm"), lame: reqs.includes("/vendor/lamejs/lame.all.js"), mp3worker: reqs.includes("/workers/mp3-worker.js"), pages: ["/", "/repair", "/licenses"].every((p) => reqs.includes(p)), assets: assets.length, missing: assets.filter((a) => !reqs.includes(decodeURIComponent(a))) };
  });
  console.log(`   cache ${cacheInfo.name}: ${cacheInfo.count} files`);
  check("precache holds RNNoise wasm, MP3 encoder + worker, all three pages", cacheInfo.wasm && cacheInfo.lame && cacheInfo.mp3worker && cacheInfo.pages);
  check("EVERY /_next/static asset the /repair HTML references is in the precache", cacheInfo.assets > 3 && cacheInfo.missing.length === 0, `${cacheInfo.assets} referenced, missing: ${cacheInfo.missing.join(", ") || "none"}`);
  const dc = await page.evaluate(() => { try { structuredClone(new AudioBuffer({ length: 10, sampleRate: 48000 })); return "cloned"; } catch (e) { return e.name; } });
  check("AudioBuffer is NOT structured-cloneable in this browser (why we store Float32 PCM)", dc === "DataCloneError", dc);

  // ================= B. go OFFLINE, reload from the service worker cache =================
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("h1:has-text('Repair vocal')", { timeout: 30000 });
  check("OFFLINE reload of /repair renders from the cache", (await page.textContent("[data-testid=net-status]")) === "Offline");

  // ================= C. full repair flow offline: RNNoise wasm, chain, preset switch =================
  await loadInputAndRender();
  const nr = await stageStatus("noiseReduction");
  check("OFFLINE: RNNoise denoiser ran (wasm served from cache): stage 'applied'", /applied/.test(nr), nr.slice(0, 80));
  check("OFFLINE: all non-analysis stages applied", await page.evaluate(() => ["hpf", "noiseReduction", "expander", "deess", "eq", "compressor", "saturation", "space", "limiter"].every((id) => /applied/.test(document.querySelector(`[data-stage=${id}]`)?.textContent ?? ""))));
  check("active preset is shown", /Active preset: Neutral/.test((await page.textContent("[data-testid=active-preset]")) ?? ""));
  const wasmFetch = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("rnnoise.wasm")).map((e) => ({ transfer: e.transferSize, swStart: e.workerStart })));
  console.log("   wasm resource timing:", JSON.stringify(wasmFetch));

  await page.fill("[data-testid=meta-artist]", "Lil/Test*");
  await page.fill("[data-testid=meta-track]", 'First: Take?');
  const neutralWav = await exportFile("wav", "neutral");
  check("filename = {artist}_{track}_{preset}.wav, sanitized", neutralWav.name === "Lil-Test_First-Take_neutral.wav", neutralWav.name);
  const mN = measure(neutralWav.file);
  check("WAV export is 48 kHz MONO", mN.sampleRate === 48000 && mN.channels === 1, `${mN.sampleRate} Hz, ${mN.channels} ch`);
  check("neutral export status 'met': -14 LUFS +-0.5 (independent Phase 1 measurement of the downloaded file)", neutralWav.status === "met" && Math.abs(mN.lufs - -14) <= 0.5, `${neutralWav.status}, ${mN.lufs.toFixed(2)} LUFS`);
  check("WAV export: true peak <= -1 dBTP (+0.05)", mN.truePeakDbtp <= -0.95, `${mN.truePeakDbtp.toFixed(2)} dBTP`);

  // switch preset -> re-render
  await page.selectOption("[data-testid=preset-picker]", "drill");
  await page.waitForFunction(() => /Active preset: Drill/.test(document.querySelector("[data-testid=active-preset]")?.textContent ?? ""));
  await page.waitForFunction(() => !!document.querySelector("[data-testid=busy]"), null, { timeout: 5000 }).catch(() => {});
  await waitIdle();
  await page.waitForFunction(() => /applied/.test(document.querySelector("[data-stage=limiter]")?.textContent ?? ""));
  const drillWav = await exportFile("wav", "drill");
  check("switching preset re-rendered: drill export differs from neutral export", sha(drillWav.bytes) !== sha(neutralWav.bytes), `${sha(neutralWav.bytes)} vs ${sha(drillWav.bytes)}`);
  check("filename carries the active preset", drillWav.name === "Lil-Test_First-Take_drill.wav", drillWav.name);
  const mD = measure(drillWav.file);
  // this synthetic vowel stream stays dynamic even after the drill chain (peak-to-loudness ~16 dB), so the CEILING-WINS path is exercised here
  check("drill export: ceiling wins over the target (status 'ceiling-limited', quieter than -14 but within 2 LU), true peak <= -1 dBTP", drillWav.status === "ceiling-limited" && mD.lufs < -14 && mD.lufs > -16 && mD.truePeakDbtp <= -0.95, `${drillWav.status}, ${mD.lufs.toFixed(2)} LUFS, ${mD.truePeakDbtp.toFixed(2)} dBTP`);

  // MP3 offline
  const mp3 = await exportFile("mp3", "drill");
  check("MP3 export works OFFLINE (encoder worker + lamejs from cache)", mp3.name === "Lil-Test_First-Take_drill.mp3" && mp3.bytes.length > 10000 && mp3.bytes[0] === 0xff, `${mp3.name}, ${mp3.bytes.length} bytes`);
  const dec = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new AudioContext({ sampleRate: 48000 }); const ab = await ctx.decodeAudioData(bin.buffer); const ch = ab.getChannelData(0); await ctx.close();
    let s = ""; const u8 = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength); for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
    return { sr: ab.sampleRate, ch: ab.numberOfChannels, len: ab.length, b64: btoa(s) };
  }, mp3.bytes.toString("base64"));
  const f32 = Buffer.from(dec.b64, "base64");
  const wavHdr = Buffer.alloc(44); wavHdr.write("RIFF", 0); wavHdr.writeUInt32LE(36 + f32.length, 4); wavHdr.write("WAVEfmt ", 8); wavHdr.writeUInt32LE(16, 16); wavHdr.writeUInt16LE(3, 20); wavHdr.writeUInt16LE(1, 22); wavHdr.writeUInt32LE(dec.sr, 24); wavHdr.writeUInt32LE(dec.sr * 4, 28); wavHdr.writeUInt16LE(4, 32); wavHdr.writeUInt16LE(32, 34); wavHdr.write("data", 36); wavHdr.writeUInt32LE(f32.length, 40);
  const decPath = path.join(OUT, "drill-mp3-decoded.wav"); writeFileSync(decPath, Buffer.concat([wavHdr, f32]));
  const mM = measure(decPath);
  check("MP3 decodes (by Chromium) as mono 48 kHz at about the right length", dec.ch === 1 && dec.sr === 48000 && Math.abs(dec.len / dec.sr - mD.seconds) < 0.1, `${dec.ch} ch, ${dec.sr} Hz, ${(dec.len / dec.sr).toFixed(2)} s vs ${mD.seconds.toFixed(2)} s`);
  check("DECODED MP3 loudness within 1.2 LU of the WAV of the same preset (codec + 0.5 dB ceiling margin)", Math.abs(mM.lufs - mD.lufs) <= 1.2, `${mM.lufs.toFixed(2)} vs ${mD.lufs.toFixed(2)} LUFS`);
  check("DECODED MP3: true peak <= -1 dBTP (the MP3 ceiling margin works)", mM.truePeakDbtp <= -0.95, `${mM.truePeakDbtp.toFixed(2)} dBTP`);

  // ================= D. persistence (real IndexedDB), reload, restore, determinism =================
  await page.waitForSelector("[data-testid=session-list] li", { timeout: 20000 });
  await page.click("[data-testid=save-session]");
  await page.waitForTimeout(600);
  const sid = await page.getAttribute("[data-testid=session-list] li", "data-session");
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("[data-testid=session-list] li");
  check("session list survives a reload (IndexedDB), offline", (await page.getAttribute("[data-testid=session-list] li", "data-session")) === sid);
  await page.click("[data-testid=open-session]");
  await page.waitForFunction(() => /Active preset: Drill/.test(document.querySelector("[data-testid=active-preset]")?.textContent ?? ""), null, { timeout: 60000 });
  check("restored: preset, artist and track come back", (await page.inputValue("[data-testid=meta-artist]")) === "Lil/Test*" && (await page.inputValue("[data-testid=meta-track]")) === "First: Take?");
  await waitIdle();
  const skip2 = page.getByRole("button", { name: /Skip de-plosive|Apply to/ });
  await page.waitForFunction(() => { const b = document.querySelector("[data-testid=render]"); return b && !b.disabled; }, null, { timeout: 60000 });
  check("restored: saved pop decision re-applied (render not blocked)", (await skip2.count()) === 0 || (await page.getByText(/Confirmed|Skipped/).count()) > 0);
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => /applied/.test(document.querySelector("[data-stage=limiter]")?.textContent ?? ""), null, { timeout: 120000 });
  await waitIdle();
  const again = await exportFile("wav", "restored");
  check("BIT-EXACT: render+export from the restored session == original drill export (source PCM + config round-tripped through IndexedDB)", sha(again.bytes) === sha(drillWav.bytes), `${sha(again.bytes)} vs ${sha(drillWav.bytes)}`);

  // ================= E. interrupted render recovery =================
  await page.evaluate(async (sessionId) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("vocal-repair"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction("renders", "readwrite"); tx.objectStore("renders").put({ id: sessionId + ":zombie", sessionId, startedAt: Date.now() - 5000, finishedAt: null, status: "running", error: null, configFingerprint: "dead" }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  }, sid);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("[data-testid=interrupted-banner]", { timeout: 20000 });
  check("a render left 'running' by a dead page is detected on the next start", /cannot be resumed mid-way/.test((await page.textContent("[data-testid=interrupted-banner]")) ?? ""));
  await page.click("[data-testid=resume-render]");
  await page.waitForFunction(() => /applied/.test(document.querySelector("[data-stage=limiter]")?.textContent ?? ""), null, { timeout: 120000 });
  await waitIdle();
  check("'Restore and re-render' re-ran the WHOLE render from saved state and cleared the banner", (await page.$("[data-testid=interrupted-banner]")) === null);

  check("no failed same-origin requests while offline", failedReqs.filter((r) => r.startsWith(BASE)).length === 0, failedReqs.slice(0, 3).join(" | "));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: `${OUT}/06-pwa-offline.png`, fullPage: true });
} catch (e) {
  check("e2e script completed", false, String(e));
  await page.screenshot({ path: `${OUT}/fail-pwa.png`, fullPage: true }).catch(() => {});
} finally {
  writeFileSync(`${OUT}/pwa-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
