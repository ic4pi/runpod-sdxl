// Pro phrasing e2e against the PRODUCTION build: real `next start` (edge route, real Anthropic SDK) -> STUB Anthropic server (no real API key/network).
// Also proves in a real browser that the Free path (/repair) makes zero /api/phrasing requests.
// Usage: npm run build && npm run e2e:pro
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const PORT = process.env.PORT ?? "3142";
const STUB_PORT = process.env.STUB_PORT ?? "3199";
const BASE = `http://localhost:${PORT}`;
if (!existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first.");
const KEY = "e2e-pro-key-0123456789";
const NONCE = "n".repeat(40);
const payload = JSON.parse(execFileSync("npx", ["tsx", "scripts/pro-fixture.ts"], { encoding: "utf8" }).trim().split("\n").pop());

// ---- stub Anthropic: mode decides what the "model" says
let mode = "good";
const upstream = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    upstream.push({ url: req.url, model: j.model, hasFormat: !!j.output_config?.format, effort: j.output_config?.effort, turns: j.messages?.length });
    const first = j.messages[0].content;
    const p = JSON.parse(first.slice(first.indexOf("{")));
    const items = p.detected_findings.map((f) => ({ coaching_id: f.coaching_id, headline: f.tier1.title, explanation: `In plain words: ${f.tier1.message}`, suggested_move: f.tier1.suggested_move }));
    if (mode === "bad") items[0].suggested_move = "Cut 777 dB.";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: JSON.stringify({ items }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 900, output_tokens: 300 } }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, r));

const env = { ...process.env, ANTHROPIC_API_KEY: "sk-stub", ANTHROPIC_BASE_URL: `http://localhost:${STUB_PORT}`, PRO_TOKEN_HASHES: createHash("sha256").update(KEY).digest("hex") };
const server = spawn("npx", ["next", "start", "-p", PORT], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} stub.close(); };
process.on("exit", stop);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("next start did not start")), 60000);
  server.stdout.on("data", (b) => { if (String(b).includes("Ready")) { clearTimeout(t); resolve(); } });
  server.on("exit", () => reject(new Error("next start exited")));
});

const results = [];
const check = (name, pass, detail = "") => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + detail : ""}`); };
const post = (body, headers = {}) => fetch(`${BASE}/api/phrasing`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-install-nonce": NONCE, ...headers }, body: JSON.stringify(body ?? { payload }) });

try {
  mode = "good";
  let r = await post();
  let b = await r.json();
  check("good model answer -> 200, source llm, 1 upstream call", r.status === 200 && b.source === "llm" && upstream.length === 1, `source=${b.source} upstream=${upstream.length}`);
  check("SDK request: model, structured output format, effort low", upstream[0].model === "claude-haiku-5-5" && upstream[0].hasFormat && upstream[0].effort === "low", JSON.stringify(upstream[0]));

  r = await post();
  b = await r.json();
  check("identical request -> served from cache, NO new upstream call", b.source === "cache" && upstream.length === 1, `source=${b.source} upstream=${upstream.length}`);

  mode = "bad";
  const other = structuredClone(payload);
  other.detected_findings[0].delta = Math.round((other.detected_findings[0].delta + 0.3) * 10) / 10;
  other.metric_deltas[other.detected_findings[0].metric_id].delta = other.detected_findings[0].delta;
  const before = upstream.length;
  r = await post({ payload: other });
  b = await r.json();
  check("hallucinated number every time -> 3 upstream calls then Tier 1 text, HTTP 200", r.status === 200 && b.source === "tier1-fallback" && upstream.length - before === 3 && !JSON.stringify(b.items).includes("777"), `calls=${upstream.length - before} source=${b.source}`);
  check("retry turn carries the rejection (3 turns on 2nd retry)", upstream[upstream.length - 1].turns === 5, `turns=${upstream[upstream.length - 1].turns}`);

  r = await post(undefined, { authorization: "Bearer not-the-key-0000" });
  check("wrong key -> 401, no upstream call", r.status === 401 && upstream.length === before + 3);
  r = await fetch(`${BASE}/api/phrasing`);
  check("GET -> 405", r.status === 405);
  r = await post({ payload: { ...payload, coaching_ids: ["lufs_over"] } });
  check("payload not matching its own findings -> 400", r.status === 400);
} catch (e) {
  check("api checks ran", false, String(e));
}

// ---- Free path in a real browser: zero /api/phrasing requests
function findChromium() {
  if (process.env.PW_EXE) return process.env.PW_EXE;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium")).sort().reverse())
    for (const sub of readdirSync(path.join(root, d))) { const exe = path.join(root, d, sub, "chrome"); if (existsSync(exe)) return exe; }
  throw new Error("No Chromium found. Set PW_EXE.");
}
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const page = await browser.newPage();
const hits = [];
page.on("request", (rq) => { if (rq.url().includes("/api/phrasing")) hits.push(rq.url()); });
await page.goto(`${BASE}/repair`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const proShown = await page.locator('[data-testid="pro-section"]').count();
check("/repair renders (Pro slot present, no key, no reference yet)", proShown === 1);
check("Free path: ZERO requests to /api/phrasing on load, and no key = no call", hits.length === 0, `hits=${hits.length}`);
await browser.close();

stop();
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
