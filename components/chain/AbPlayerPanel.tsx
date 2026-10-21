"use client";

import { useEffect, useRef, useState } from "react";
import { AbPlayer, type Side } from "@/lib/audio/abPlayer";
import { encodeWav } from "@/lib/dsp/fixtures/wav";
import { useChain } from "@/lib/state/chainStore";
import { WaveformOverlay } from "./WaveformOverlay";

/** Level-matched A/B of the original (mono, internal rate) against the processed buffer. */
export function AbPlayerPanel() {
  const { original, result, match, cfg, source } = useChain();
  const processed = result?.processed ?? null;
  const [side, setSide] = useState<Side>("processed");
  const [matched, setMatched] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const player = useRef<AbPlayer | null>(null);

  const gains = match && "gains" in match ? match.gains : null;
  const gainDb = gains && matched ? { original: gains.originalGainDb, processed: gains.processedGainDb } : null;

  useEffect(() => {
    player.current?.dispose();
    player.current = null;
    setPlaying(false);
    setPos(0);
    if (!original || !processed) return;
    const p = new AbPlayer({ original, processed }, { original: 0, processed: 0 }, cfg.ab.crossfadeMs);
    p.onEnded = () => setPlaying(false);
    player.current = p;
    return () => p.dispose();
  }, [original, processed, cfg.ab.crossfadeMs]);

  useEffect(() => {
    player.current?.setLevelMatch(gainDb ?? { original: 0, processed: 0 });
  }, [gainDb?.original, gainDb?.processed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    player.current?.setSide(side);
  }, [side, original, processed]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (player.current) setPos(player.current.position);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!original) return null;
  const p = player.current;

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 p-3">
      <h2 className="font-semibold">Before / after</h2>
      <WaveformOverlay original={original} processed={processed} gainDb={gainDb} position={pos} onSeek={(s) => void p?.seek(s)} />
      {processed ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded bg-emerald-600 px-3 py-1 font-medium hover:bg-emerald-500"
              data-testid="play"
              onClick={async () => {
                if (!p) return;
                if (p.isPlaying) {
                  p.pause();
                  setPlaying(false);
                } else {
                  await p.play();
                  setPlaying(true);
                }
              }}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <div className="inline-flex overflow-hidden rounded border border-neutral-700" role="group" aria-label="A/B">
              {(["original", "processed"] as const).map((s) => (
                <button
                  key={s}
                  data-testid={`side-${s}`}
                  className={`px-3 py-1 text-sm ${side === s ? "bg-neutral-100 text-neutral-900" : "hover:bg-neutral-800"}`}
                  onClick={() => setSide(s)}
                >
                  {s === "original" ? "A: Original" : "B: Processed"}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} data-testid="level-match" />
              Level-matched
            </label>
            <span className="text-xs text-neutral-400 tabular-nums">
              {pos.toFixed(1)} / {Math.max(original.duration, processed.duration).toFixed(1)} s
            </span>
            <button
              className="ml-auto rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
              onClick={() => {
                const wav = encodeWav({ sampleRate: processed.sampleRate, channels: [processed.getChannelData(0)] }, 16);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
                a.download = `${(source?.name ?? "vocal").replace(/\.[^.]+$/, "")}-repaired.wav`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download WAV
            </button>
          </div>
          <p className="text-xs text-neutral-400" data-testid="match-info">
            {match === null
              ? "Measuring levels..."
              : "error" in match
                ? `Level matching unavailable: ${match.error}`
                : `Matched by ${match.gains.method}: original ${match.gains.originalGainDb.toFixed(1)} dB, processed ${match.gains.processedGainDb.toFixed(1)} dB (the louder side is turned down).`}
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-500">Render to compare.</p>
      )}
    </section>
  );
}
