"use client";

import { useEffect, useState } from "react";
import { deliverFile, plannedDelivery, type DeliveryMethod } from "@/lib/export/download";
import { exportAudio, type ExportFormat, type ExportResult } from "@/lib/export/exporter";
import { useChain } from "@/lib/state/chainStore";

const METHOD_TEXT: Record<DeliveryMethod, string> = {
  "share-sheet": "opens the share sheet: choose “Save to Files”",
  "download-link": "downloads to your device",
  "open-in-tab": "opens in a new tab: use the browser’s Save / Share",
};

/** Export WAV or MP3 at the loudness target, true-peak limited. Two taps: prepare, then save (iOS needs a fresh tap to share). */
export function ExportPanel() {
  const { result, cfg, presetId, metadata, setMetadata, exportFormat, setExportFormat } = useChain();
  const [working, setWorking] = useState(false);
  const [out, setOut] = useState<ExportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<DeliveryMethod | null>(null);

  useEffect(() => {
    setOut(null);
    setDelivered(null);
  }, [result, presetId, exportFormat, metadata.artist, metadata.track]);

  const ex = cfg.export;
  const processed = result?.processed ?? null;

  const prepare = async () => {
    if (!processed) return;
    setWorking(true);
    setErr(null);
    setOut(null);
    try {
      setOut(
        await exportAudio({ pcm: processed.getChannelData(0), sampleRate: processed.sampleRate, cfg, format: exportFormat, artist: metadata.artist, track: metadata.track, presetId }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const input = "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm";
  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 p-3" data-testid="export-section">
      <h2 className="font-semibold">Export</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-neutral-400">
          Artist
          <input className={input} value={metadata.artist} onChange={(e) => setMetadata({ artist: e.target.value })} placeholder="Artist name" data-testid="meta-artist" />
        </label>
        <label className="text-xs text-neutral-400">
          Track
          <input className={input} value={metadata.track} onChange={(e) => setMetadata({ track: e.target.value })} placeholder="Track title" data-testid="meta-track" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {(["wav", "mp3"] as ExportFormat[]).map((f) => (
          <label key={f} className="flex items-center gap-1">
            <input type="radio" name="fmt" checked={exportFormat === f} onChange={() => setExportFormat(f)} data-testid={`fmt-${f}`} />
            {f.toUpperCase()}
          </label>
        ))}
      </div>
      <p className="text-xs text-neutral-400" data-testid="export-facts">
        Exports are <strong>48 kHz mono</strong> (the repair chain is mono; nothing is upsampled to fake stereo). Brought to <strong>{ex.targetLufs} LUFS</strong> integrated, peaks held at{" "}
        <strong>{cfg.stages.limiter.params.ceilingDbtp} dBTP</strong>
        {exportFormat === "mp3" ? ` (${cfg.stages.limiter.params.ceilingDbtp - ex.mp3.ceilingMarginDb} dBTP before encoding, since MP3 decoders can overshoot), ${ex.mp3.bitrateKbps} kbps` : `, ${ex.wav.bitDepth}-bit${ex.wav.dither && ex.wav.bitDepth === 16 ? " with TPDF dither" : ""}`}.
        {exportFormat === "mp3" && (
          <>
            {" "}
            MP3 encoding uses LAME-derived <a className="underline" href="/licenses">lamejs (LGPL-3.0)</a>.
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded bg-emerald-600 px-3 py-1 font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!processed || working}
          onClick={() => void prepare()}
          data-testid="export-prepare"
        >
          {working ? "Preparing…" : `Prepare ${exportFormat.toUpperCase()}`}
        </button>
        {!processed && <span className="text-xs text-neutral-500">Render first.</span>}
      </div>
      {err && (
        <p className="rounded border border-red-700 bg-red-950 p-2 text-xs text-red-300" data-testid="export-error">
          {err}
        </p>
      )}
      {out && (
        <div className="space-y-2 rounded border border-neutral-700 p-2 text-xs" data-testid="export-ready">
          <p className={out.report.status === "met" ? "text-emerald-400" : "text-amber-400"} data-testid="export-status" data-status={out.report.status}>
            {out.report.status === "met" ? "On target" : out.report.status === "ceiling-limited" ? "Quieter than target: the peak ceiling wins" : "Loudness not measured (clip too short)"}
          </p>
          <p className="text-neutral-300">
            {out.report.outputLufs !== null ? `${out.report.outputLufs.toFixed(1)} LUFS (target ${out.report.targetLufs}) · ` : ""}
            true peak {out.report.outputTruePeakDbtp.toFixed(2)} dBTP (ceiling {out.report.ceilingDbtp}) · limiter up to {out.report.limiterMaxReductionDb.toFixed(1)} dB · {out.channels === 1 ? "mono" : "stereo"} {out.sampleRate / 1000} kHz ·{" "}
            {(out.blob.size / 1024 / 1024).toFixed(2)} MB
          </p>
          <p className="text-neutral-500">{out.report.note}</p>
          <button
            className="rounded bg-neutral-100 px-3 py-1 font-medium text-neutral-900 hover:bg-white"
            data-testid="export-save"
            onClick={async () => setDelivered(await deliverFile(out.blob, out.filename))}
          >
            Save {out.filename}
          </button>
          <p className="text-neutral-500" data-testid="export-method">
            This device: {METHOD_TEXT[plannedDelivery(new File([out.blob], out.filename, { type: out.blob.type }))]}.{delivered ? ` Done via ${delivered}.` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
