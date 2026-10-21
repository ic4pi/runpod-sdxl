"use client";

import { useEffect, useMemo, useRef } from "react";
import { computePeaks } from "@/lib/audio/peaks";

/** Before/after waveform on a shared time axis. Original = grey, processed = green. Click to seek. */
export function WaveformOverlay({
  original,
  processed,
  gainDb,
  position,
  onSeek,
}: {
  original: AudioBuffer;
  processed: AudioBuffer | null;
  /** Level-match gains applied to the drawing too, so the overlay shows what you hear. */
  gainDb: { original: number; processed: number } | null;
  position: number;
  onSeek: (sec: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const total = Math.max(original.duration, processed?.duration ?? 0);
  const COLS = 1200;
  const peaks = useMemo(() => {
    const gO = gainDb ? Math.pow(10, gainDb.original / 20) : 1;
    const gP = gainDb ? Math.pow(10, gainDb.processed / 20) : 1;
    return {
      o: computePeaks(original.getChannelData(0), original.sampleRate, COLS, total, gO),
      p: processed ? computePeaks(processed.getChannelData(0), processed.sampleRate, COLS, total, gP) : null,
    };
  }, [original, processed, total, gainDb]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    g.strokeStyle = "#262626";
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();
    const draw = (p: { min: Float32Array; max: Float32Array }, color: string) => {
      g.fillStyle = color;
      for (let c = 0; c < COLS; c++) {
        const x = (c / COLS) * w;
        const y1 = mid - Math.min(1, p.max[c]!) * mid;
        const y2 = mid - Math.max(-1, p.min[c]!) * mid;
        g.fillRect(x, y1, Math.max(1, w / COLS), Math.max(1, y2 - y1));
      }
    };
    draw(peaks.o, "rgba(163,163,163,0.55)");
    if (peaks.p) draw(peaks.p, "rgba(16,185,129,0.65)");
    const px = (position / total) * w;
    g.fillStyle = "#fafafa";
    g.fillRect(px, 0, 1, h);
  }, [peaks, position, total]);

  return (
    <div>
      <canvas
        ref={ref}
        className="h-40 w-full cursor-pointer rounded bg-neutral-950"
        data-testid="waveform"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * total);
        }}
      />
      <p className="mt-1 flex gap-4 text-xs text-neutral-400">
        <span><span className="mr-1 inline-block h-2 w-2 bg-neutral-400" />Original</span>
        <span><span className="mr-1 inline-block h-2 w-2 bg-emerald-500" />Processed</span>
        <span>{total.toFixed(1)} s</span>
      </p>
    </div>
  );
}
