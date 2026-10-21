"use client";

import { useEffect, useRef, useState } from "react";
import { buildCases, runHarness, syntheticBases, type HarnessResult } from "@/lib/dsp/defects/harness";
import { createMeasureClient, pcmFromAudioBuffer, type MeasureClient } from "@/lib/dsp/measure/client";
import type { Pcm } from "@/lib/dsp/measure/types";

const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
const th = "px-2 py-1 text-left font-medium border-b border-neutral-700 whitespace-nowrap";
const td = "px-2 py-1 border-b border-neutral-800 whitespace-nowrap tabular-nums";

export default function DefectsClient() {
  const client = useRef<MeasureClient | null>(null);
  const [upload, setUpload] = useState<{ name: string; pcm: Pcm } | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [result, setResult] = useState<HarnessResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.current = createMeasureClient();
    return () => client.current?.terminate();
  }, []);

  async function onFile(file: File | undefined) {
    if (!file) return setUpload(null);
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      await ctx.close();
      setUpload({ name: file.name, pcm: pcmFromAudioBuffer(buf) });
    } catch (e) {
      setError(`Could not decode ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function run() {
    setError(null);
    setResult(null);
    try {
      setStatus("generating cases");
      const bases = upload ? [{ name: upload.name, seed: 1, pcm: upload.pcm }] : syntheticBases();
      const cases = buildCases(bases, !upload);
      const t0 = performance.now();
      const res = await runHarness(
        cases,
        (pcm, print) => client.current!.measure(pcm, print),
        undefined,
        (d, t) => setStatus(`measuring ${d}/${t}`),
      );
      setResult(res);
      setStatus(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s (worker)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("failed");
    }
  }

  return (
    <main className="mx-auto max-w-6xl p-4 text-sm">
      <h1 className="text-lg font-semibold">Defect harness (dev only)</h1>
      <p className="mt-1 text-neutral-400">
        Injects one defect at a time into a clean vocal and runs every detector on control and injected audio, in a Web Worker.
        All thresholds are placeholders (lib/dsp/measure/thresholds.ts).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input type="file" accept="audio/*" onChange={(e) => onFile(e.target.files?.[0])} data-testid="file" />
        <button className="rounded bg-emerald-600 px-3 py-1 font-medium hover:bg-emerald-500" onClick={run} data-testid="run">
          Run harness {upload ? `(${upload.name})` : "(synthetic vocals)"}
        </button>
        <span data-testid="status" className="text-neutral-400">
          {status}
        </span>
      </div>
      {upload && (
        <p className="mt-1 text-amber-400">
          Uploaded file: noise print = quietest 2.5 s window; plosive injection points found by onset detection.
        </p>
      )}
      {error && (
        <pre className="mt-3 whitespace-pre-wrap rounded border border-red-700 bg-red-950 p-2 text-red-300" data-testid="error">
          {error}
        </pre>
      )}

      {result && (
        <>
          <h2 className="mt-6 font-semibold">Per-detector (n = {result.caseCount} cases)</h2>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full" data-testid="detector-table">
              <thead>
                <tr>
                  {["detector", "fires_on_defect", "false_positive_on_control", "precision", "recall", "TP", "FP", "FN", "TN", "mild", "moderate", "severe", "cross-fires"].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.detector}>
                    <td className={td}>{r.detector}</td>
                    <td className={td}>
                      {String(r.fires_on_defect)} ({r.firedOnDefect})
                    </td>
                    <td className={td}>
                      {String(r.false_positive_on_control)} ({r.firedOnControl})
                    </td>
                    <td className={td}>{f(r.precision)}</td>
                    <td className={td}>{f(r.recall)}</td>
                    <td className={td}>{r.tp}</td>
                    <td className={td}>{r.fp}</td>
                    <td className={td}>{r.fn}</td>
                    <td className={td}>{r.tn}</td>
                    <td className={td}>{r.recallBySeverity.mild}</td>
                    <td className={td}>{r.recallBySeverity.moderate}</td>
                    <td className={td}>{r.recallBySeverity.severe}</td>
                    <td className={td}>{r.crossFires.join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-6 font-semibold">Per-case verdicts (F = fired; value = detector metric)</h2>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full" data-testid="case-table">
              <thead>
                <tr>
                  <th className={th}>case</th>
                  {result.rows.map((r) => (
                    <th key={r.detector} className={th}>
                      {r.detector}
                    </th>
                  ))}
                  <th className={th}>worker ms</th>
                </tr>
              </thead>
              <tbody>
                {result.outcomes.map((o) => (
                  <tr key={o.name}>
                    <td className={td}>{o.name}</td>
                    {result.rows.map((r) => {
                      const v = o.verdicts[r.detector];
                      const bad = v.fired !== (o.expected === r.detector);
                      return (
                        <td key={r.detector} className={`${td} ${bad ? "text-red-400" : v.fired ? "text-emerald-400" : "text-neutral-500"}`}>
                          {v.fired ? "F" : "."} {v.metric.value.toFixed(4)} {v.metric.unit}
                        </td>
                      );
                    })}
                    <td className={td}>{o.report.totalElapsedMs.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-neutral-500">Red = wrong (false positive or miss).</p>

          <h2 className="mt-6 font-semibold">Measurements on first clean control</h2>
          <ControlReport result={result} />
        </>
      )}
    </main>
  );
}

function ControlReport({ result }: { result: HarnessResult }) {
  const r = result.outcomes.find((o) => o.defect === null)!.report;
  const rows: [string, string][] = [];
  const add = (k: string, v: string) => rows.push([k, v]);
  if (r.loudness.ok) {
    add("Integrated", `${r.loudness.value.integrated.value.toFixed(1)} LUFS`);
    add("Short-term max", `${r.loudness.value.shortTermMax.value.toFixed(1)} LUFS`);
    add("LRA", `${r.loudness.value.lra.value.toFixed(1)} LU`);
  }
  if (r.truePeak.ok) add("True peak", `${r.truePeak.value.truePeak.value.toFixed(2)} dBTP (sample ${r.truePeak.value.samplePeak.value.toFixed(2)} dBFS)`);
  if (r.crest.ok) add("Crest (whole / active)", `${r.crest.value.crest.value.toFixed(1)} / ${r.crest.value.activeCrest.value.toFixed(1)} dB`);
  if (r.noise.ok) add("Noise floor / SNR", `${r.noise.value.noiseFloor.value.toFixed(1)} dBFS / ${r.noise.value.snr.value.toFixed(1)} dB`);
  if (r.dcOffset.ok) add("DC offset", `${r.dcOffset.value.maxAbs.value.toExponential(2)} FS`);
  if (r.clipping.ok) add("Clipping runs / true overs", `${r.clipping.value.runCount.value} / ${r.clipping.value.trueOverCount.value}`);
  if (r.thirdOctave.ok)
    add("Third-octave (Hz: dBFS)", r.thirdOctave.value.bands.map((b) => `${Math.round(b.centerHz)}:${b.level.value.toFixed(0)}`).join("  "));
  add("Correlation", r.correlation.ok ? r.correlation.value.correlation.value.toFixed(3) : `n/a (${r.correlation.error.code})`);
  return (
    <table className="mt-2">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className={`${td} text-neutral-400`}>{k}</td>
            <td className={`${td} whitespace-normal`}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
