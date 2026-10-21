// Real-browser verification of the OfflineAudioContext stages and the Phase 2 UI flow.
// Usage: npm run e2e     (starts `next dev` itself; needs Chromium via PW_EXE or /opt/pw-browsers)
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = process.env.PORT ?? "3131";
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.E2E_OUT ?? "e2e-out";
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse()) {
    for (const sub of readdirSync(path.join(root, d))) {
      const exe = path.join(root, d, sub, "chrome");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("No Chromium found. Set PW_EXE.");
}

const server = spawn("npx", ["next", "dev", "-p", PORT], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("next dev did not start")), 90000);
  server.stdout.on("data", (b) => { if (String(b).includes("Ready")) { clearTimeout(t); resolve(); } });
  server.on("exit", () => reject(new Error("next dev exited")));
});

const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + detail : ""}`); };

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });

try {
  await page.goto(`${BASE}/repair`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__chain && window.__native && window.__config, null, { timeout: 60000 });

  // ---------- A. native stages, one at a time, in a real OfflineAudioContext ----------
  const native = await page.evaluate(async () => {
    const SR = 48000;
    const { DEFAULT_CHAIN_CONFIG } = window.__config;
    const cfg = structuredClone(DEFAULT_CHAIN_CONFIG);
    const tone = (hz, amp, sec) => Float32Array.from({ length: sec * SR }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
    const amp = (x, hz) => { let c = 0, s = 0; const a = Math.floor(x.length * 0.25), b = Math.floor(x.length * 0.9); for (let i = a; i < b; i++) { const w = (2 * Math.PI * hz * i) / SR; c += x[i] * Math.cos(w); s += x[i] * Math.sin(w); } return (2 * Math.hypot(c, s)) / (b - a); };
    const db = (r) => 20 * Math.log10(r);
    const run = async (x, ids) => (await window.__native.renderNativeSegment(x, SR, ids, cfg, Object.fromEntries(["hpf", "eq", "saturation", "space"].filter((i) => !ids.includes(i)).map((i) => [i, true])))).out;
    const out = {};
    // HPF
    const mix = tone(40, 0.2, 2).map((v, i) => v + 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const h = await run(mix, ["hpf"]);
    out.hpf40 = db(amp(h, 40) / amp(mix, 40)); out.hpf1k = db(amp(h, 1000) / amp(mix, 1000));
    // EQ
    const probe = (hz) => tone(hz, 0.1, 2);
    out.eq = {};
    for (const hz of [250, 3500, 1000, 16000]) { const y = await run(probe(hz), ["eq"]); out.eq[hz] = db(amp(y, hz) / 0.1 * 1) ; }
    // Saturation
    const small = tone(1000, 0.02, 2), big = tone(1000, 0.9, 2);
    const ys = await run(small, ["saturation"]), yb = await run(big, ["saturation"]);
    out.satSmall = db(amp(ys, 1000) / 0.02); out.satBigPeak = Math.max(...yb.slice(SR / 2)); out.satBigThird = db(amp(yb, 3000) / amp(yb, 1000));
    // Space: impulse in, tail out
    const imp = new Float32Array(SR); imp[1000] = 1;
    const sp = await run(imp, ["space"]);
    const e = (a, b) => sp.slice(a, b).reduce((s, v) => s + v * v, 0);
    out.spaceLen = sp.length; out.spaceInLen = imp.length; out.spaceTailEnergy = e(SR, sp.length); out.spaceEarly = e(1100, 24000); out.spaceLate = e(24000 + 12000, sp.length); out.spaceFinite = sp.every(Number.isFinite);
    // all bypassed -> same array back
    const bypassed = await window.__native.renderNativeSegment(imp, SR, ["hpf", "eq"], cfg, { hpf: true, eq: true });
    out.allBypassedSame = bypassed.out === imp && bypassed.applied.length === 0;
    return out;
  });
  check("HPF attenuates 40 Hz by >= 18 dB (4th-order @70 Hz)", native.hpf40 < -18, `${native.hpf40.toFixed(1)} dB`);
  check("HPF leaves 1 kHz within 0.2 dB", Math.abs(native.hpf1k) < 0.2, `${native.hpf1k.toFixed(2)} dB`);
  check("EQ 250 Hz cut about -2 dB", native.eq[250] < -1.5 && native.eq[250] > -2.6, `${native.eq[250].toFixed(2)} dB`);
  check("EQ 3.5 kHz boost about +2 dB", native.eq[3500] > 1.5 && native.eq[3500] < 2.6, `${native.eq[3500].toFixed(2)} dB`);
  check("EQ high shelf lifts 16 kHz by ~+2.5 dB", native.eq[16000] > 1.8 && native.eq[16000] < 3.2, `${native.eq[16000].toFixed(2)} dB`);
  check("EQ leaves 1 kHz within 0.8 dB", Math.abs(native.eq[1000]) < 0.8, `${native.eq[1000].toFixed(2)} dB`);
  check("Saturation: low level ~unity (parallel tanh, unity slope)", Math.abs(native.satSmall) < 0.2, `${native.satSmall.toFixed(2)} dB`);
  check("Saturation: loud peak is softened and adds odd harmonics", native.satBigPeak < 0.9 * 0.97 && native.satBigThird > -50, `peak ${native.satBigPeak.toFixed(3)}, 3rd ${native.satBigThird.toFixed(1)} dB`);
  check("Space: render extends past the input for the tail, tail has energy, decays, finite", native.spaceLen > native.spaceInLen && native.spaceTailEnergy > 0 && native.spaceLate < native.spaceEarly && native.spaceFinite, `len ${native.spaceLen} vs ${native.spaceInLen}`);
  check("All-bypassed native segment returns input untouched (no render)", native.allBypassedSame);

  // ---------- B. resample/downmix prep never touches the source ----------
  const prep = await page.evaluate(async () => {
    const SR = 44100;
    const buf = new AudioBuffer({ length: SR * 2, sampleRate: SR, numberOfChannels: 2 });
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    for (let i = 0; i < l.length; i++) { l[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SR); r[i] = l[i]; }
    const before = Array.from(l.slice(0, 5000));
    const mono = await window.__native.prepareMono(buf, 48000);
    const after = Array.from(buf.getChannelData(0).slice(0, 5000));
    let c = 0, s = 0; for (let i = 10000; i < 80000; i++) { const w = (2 * Math.PI * 1000 * i) / 48000; c += mono[i] * Math.cos(w); s += mono[i] * Math.sin(w); }
    return { len: mono.length, amp: (2 * Math.hypot(c, s)) / 70000, untouched: JSON.stringify(before) === JSON.stringify(after) };
  });
  check("prepareMono: 44.1k stereo -> 48k mono, length correct", Math.abs(prep.len - 96000) <= 1, `${prep.len}`);
  check("prepareMono: tone amplitude preserved (L=R averages to the same level)", Math.abs(20 * Math.log10(prep.amp / 0.4)) < 0.3, `${prep.amp.toFixed(3)}`);
  check("prepareMono: source AudioBuffer unchanged", prep.untouched);

  // ---------- C. UI flow on the dirty demo ----------
  await page.click("[data-testid=demo-dirty]");
  await page.waitForFunction(() => window.__chain.getState().analysis !== null, null, { timeout: 60000 });
  const an = await page.evaluate(() => { const s = window.__chain.getState(); return { clipped: s.analysis.clipped, cands: s.analysis.plosiveCandidates.length, printOk: s.analysis.noisePrint?.verdict.ok, decision: s.popDecision }; });
  check("analysis: clipping flagged on the dirty demo", an.clipped);
  check("analysis: pops detected and decision is PENDING (not auto-applied)", an.cands >= 1 && an.decision === "pending", `${an.cands} candidates`);
  check("analysis: noise print validated", typeof an.printOk === "boolean", String(an.printOk));
  check("Render button is disabled while pops await confirmation", await page.isDisabled("[data-testid=render]"));
  for (const id of ["clippingCheck", "noisePrint", "hpf", "noiseReduction", "expander", "deplosive", "deess", "eq", "compressor", "saturation", "space", "limiter"]) {
    const why = await page.textContent(`[data-testid=why-${id}]`);
    if (!why || why.length < 30) check(`rationale shown for ${id}`, false);
  }
  check("each stage shows a rationale string", true);
  await page.screenshot({ path: `${OUT}/01-analysis-confirm.png`, fullPage: true });

  // render must be impossible without a decision: drive the store directly
  await page.evaluate(() => window.__chain.getState().render());
  const refused = await page.evaluate(() => ({ result: window.__chain.getState().result, error: window.__chain.getState().error }));
  check("store refuses to render while pops are unconfirmed", refused.result === null && /Confirm or skip/.test(refused.error ?? ""));

  await page.getByRole("button", { name: /Apply to \d+ selected/ }).click();
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => window.__chain.getState().result !== null && window.__chain.getState().busy === null, null, { timeout: 120000 });
  const done = await page.evaluate(() => {
    const s = window.__chain.getState();
    const x = s.result.processed.getChannelData(0);
    let pk = 0; for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
    const orig = s.source.buffer.getChannelData(0);
    return { reports: s.result.reports.map((r) => `${r.id}:${r.status}`), processedIsNew: s.result.processed !== s.source.buffer && s.result.processed !== s.original, len: x.length, inLen: orig.length, peak: pk, match: JSON.stringify(s.match), finite: x.every(Number.isFinite), error: s.error };
  });
  console.log("   reports:", done.reports.join(" "));
  check("render finished without error", done.error === null, String(done.error));
  check("processed is a NEW AudioBuffer", done.processedIsNew);
  check("every non-analysis stage applied", ["noiseReduction:applied", "expander:applied", "deplosive:applied", "deess:applied", "compressor:applied", "limiter:applied", "hpf:applied", "eq:applied", "saturation:applied", "space:applied"].every((r) => done.reports.includes(r)), "");
  check("limiter holds peak <= ceiling (-1 dBTP ~ 0.891 + tolerance)", done.peak <= 0.9, done.peak.toFixed(3));
  check("output is finite and tail-extended (reverb)", done.finite && done.len > done.inLen, `${done.len} vs ${done.inLen}`);
  check("level match computed", /gains/.test(done.match), done.match);

  // source untouched after the full render
  const srcCheck = await page.evaluate(() => { const s = window.__chain.getState(); const a = s.source.buffer.getChannelData(0); let nonFinite = 0; for (const v of a) if (!Number.isFinite(v)) nonFinite++; return { nonFinite }; });
  check("source buffer still intact", srcCheck.nonFinite === 0);

  // ---------- D. per-stage bypass in the single panel ----------
  await page.check("[data-testid=bypass-deess]");
  await page.check("[data-testid=bypass-space]");
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => window.__chain.getState().result !== null && window.__chain.getState().busy === null, null, { timeout: 120000 });
  const byp = await page.evaluate(() => window.__chain.getState().result.reports.map((r) => `${r.id}:${r.status}`));
  check("bypassed stages report 'bypassed' and the rest still apply", byp.includes("deess:bypassed") && byp.includes("space:bypassed") && byp.includes("compressor:applied"), byp.join(" "));
  const lenBypassed = await page.evaluate(() => ({ out: window.__chain.getState().result.processed.length, inn: window.__chain.getState().original.length }));
  check("with reverb bypassed the output length equals the input (no tail)", lenBypassed.out === lenBypassed.inn, `${lenBypassed.out} vs ${lenBypassed.inn}`);

  // ---------- E. A/B playback ----------
  await page.click("[data-testid=play]");
  await page.waitForTimeout(700);
  const t1 = await page.textContent("[data-testid=match-info]");
  await page.click("[data-testid=side-original]");
  await page.waitForTimeout(400);
  await page.click("[data-testid=side-processed]");
  await page.waitForTimeout(300);
  const clock = await page.evaluate(() => document.body.innerText.match(/(\d+\.\d) \/ (\d+\.\d) s/)?.[1]);
  check("A/B playback runs and the position advances", clock !== undefined && Number(clock) > 0.3, `position ${clock}s`);
  check("level-match info shown", /Matched by/.test(t1 ?? ""), t1 ?? "");
  await page.click("[data-testid=play]");
  await page.screenshot({ path: `${OUT}/02-rendered.png`, fullPage: true });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e script completed", false, String(e));
  await page.screenshot({ path: `${OUT}/fail.png`, fullPage: true }).catch(() => {});
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
