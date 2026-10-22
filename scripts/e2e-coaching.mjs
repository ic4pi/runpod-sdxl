// Real-browser check of the Phase 3 coaching UI. Usage: npm run e2e:coaching
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = process.env.PORT ?? "3132";
const OUT = process.env.E2E_OUT ?? "e2e-out";
mkdirSync(OUT, { recursive: true });

// The exact empty-state string lives in code (evaluate.ts); read it from there so this check can't drift from it.
const src = readFileSync("lib/decision/evaluate.ts", "utf8");
const EMPTY = src.match(/NO_REFERENCE_REASON =\s*\n?\s*"([^"]+)"/)?.[1];
if (!EMPTY) throw new Error("could not read NO_REFERENCE_REASON from evaluate.ts");

function findChromium() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse())
    for (const sub of readdirSync(path.join(root, d))) { const exe = path.join(root, d, sub, "chrome"); if (existsSync(exe)) return exe; }
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
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 2400 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });
const count = (sel) => page.locator(sel).count();

try {
  await page.goto(`http://localhost:${PORT}/repair`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__chain && window.__coaching, null, { timeout: 60000 });
  await page.click("[data-testid=demo-dirty]");
  await page.waitForFunction(() => window.__coaching.getState().metrics !== null, null, { timeout: 90000 });

  // ---- no reference selected (default) ----
  check("default reference is None", (await page.inputValue("[data-testid=reference-picker]")) === "");
  const empty = await page.textContent("[data-testid=coaching-empty]");
  check("empty-state STRING renders exactly as defined in code", empty?.trim() === EMPTY, (empty ?? "").slice(0, 70) + "...");
  check("no coaching lines without a reference", (await count("[data-testid=coaching-line]")) === 0 && (await count("[data-testid=coaching-lines]")) === 0);
  check("no delta table without a reference", (await count("[data-testid=delta-table]")) === 0);
  check("no placeholder banner without a reference", (await count("[data-testid=placeholder-banner]")) === 0);
  const rows = await page.$$eval("[data-testid=measurements-table] tr", (trs) => trs.map((t) => [t.getAttribute("data-metric"), t.children[1].textContent]));
  check("measurements still render without a reference (10 rows)", rows.length === 10, rows.map((r) => `${r[0]}=${r[1]}`).slice(0, 4).join("; "));
  check("measurements carry units", rows.filter((r) => r[0] !== "noise_floor_dbfs").every((r) => /(LUFS|LU|dBTP|dB|ratio|events\/min)$/.test(r[1] ?? "")), "");
  const state0 = await page.evaluate(() => JSON.stringify(window.__coaching.getState().metrics.noise_floor_dbfs));
  check("noise floor measured from the validated print", /"status":"ok"/.test(state0), state0);
  await page.screenshot({ path: `${OUT}/03-coaching-none.png`, fullPage: true });

  // ---- select a reference ----
  await page.selectOption("[data-testid=reference-picker]", "trap");
  await page.waitForSelector("[data-testid=delta-table]");
  const banner = await page.textContent("[data-testid=placeholder-banner]");
  check("placeholder banner shown for a placeholder profile", /Placeholder reference: not measured data/.test(banner ?? "") && /invented/.test(banner ?? ""), (banner ?? "").slice(0, 60));
  check("empty state is gone once a reference is selected", (await count("[data-testid=coaching-empty]")) === 0);
  const lines = await page.$$eval("[data-testid=coaching-line]", (els) => els.map((e) => e.getAttribute("data-rule")));
  check("coaching lines appear (dirty demo is clipped)", lines.includes("clipping_present"), lines.join(", "));
  const deltas = await page.$$eval("[data-testid=delta-table] [data-delta]", (els) => els.map((e) => e.textContent.trim()));
  check("every surfaced number in the delta table is a signed delta with a unit", deltas.length > 0 && deltas.every((t) => /^[+-][\d.e-]+ (dB|LU|ratio|events\/min)$/.test(t)), deltas.slice(0, 4).join(" | "));
  const text = await page.textContent("[data-testid=coaching-section]");
  check("each coaching line shows a suggested move", (await page.$$eval("[data-testid=coaching-line]", (els) => els.every((e) => /Try: /.test(e.textContent)))), "");
  check("profile absolute values are not rendered (e.g. trap median -19.5 LUFS)", !/-19\.5 LUFS/.test(text ?? ""), "");
  await page.screenshot({ path: `${OUT}/04-coaching-trap.png`, fullPage: true });

  // ---- back to none ----
  await page.selectOption("[data-testid=reference-picker]", "");
  await page.waitForSelector("[data-testid=coaching-empty]");
  check("deselecting returns to the empty state with no lines or deltas", (await count("[data-testid=coaching-line]")) === 0 && (await count("[data-testid=delta-table]")) === 0);

  // ---- processed target ----
  check("'Processed' measure option is disabled before a render", await page.$eval("[data-testid=measure-target] option[value=processed]", (o) => o.disabled));
  await page.evaluate(() => window.__chain.getState().popDecision === "pending" && window.__chain.getState().skipPops());
  await page.click("[data-testid=render]");
  await page.waitForFunction(() => window.__chain.getState().result !== null && window.__chain.getState().busy === null, null, { timeout: 120000 });
  const before = await page.evaluate(() => JSON.stringify(window.__coaching.getState().metrics.integrated_lufs));
  await page.selectOption("[data-testid=measure-target]", "processed");
  await page.waitForFunction((b) => window.__coaching.getState().metrics && JSON.stringify(window.__coaching.getState().metrics.integrated_lufs) !== b, before, { timeout: 90000 });
  const after = await page.evaluate(() => JSON.stringify(window.__coaching.getState().metrics.integrated_lufs));
  check("measuring the processed audio changes the metrics", before !== after, `${before} -> ${after}`);
  await page.selectOption("[data-testid=reference-picker]", "boom-bap");
  await page.waitForSelector("[data-testid=delta-table]");
  check("another profile works on processed audio", /Boom-bap/.test((await page.textContent("[data-testid=coaching-section]")) ?? ""));
  await page.screenshot({ path: `${OUT}/05-coaching-processed.png`, fullPage: true });
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e script completed", false, String(e));
  await page.screenshot({ path: `${OUT}/fail-coaching.png`, fullPage: true }).catch(() => {});
} finally {
  writeFileSync(`${OUT}/coaching-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
