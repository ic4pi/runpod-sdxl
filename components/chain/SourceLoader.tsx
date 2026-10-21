"use client";

import { useEffect, useState } from "react";
import { useChain } from "@/lib/state/chainStore";

const DEMOS = [
  { id: "clean", label: "Demo: clean synthetic vocal" },
  { id: "pops", label: "Demo: synthetic vocal with pops" },
  { id: "dirty", label: "Demo: pops + hum + clipping" },
] as const;

async function decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(bytes);
  } finally {
    void ctx.close();
  }
}

export function SourceLoader() {
  const { loadSource, source, busy } = useChain();
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/fixtures")
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((j: { files: string[] }) => setFixtures(j.files))
      .catch(() => setFixtures([]));
  }, []);

  const safe = async (name: string, get: () => Promise<AudioBuffer>) => {
    setErr(null);
    try {
      await loadSource(name, await get());
    } catch (e) {
      setErr(`Could not load ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const demo = async (id: (typeof DEMOS)[number]["id"]) => {
    if (process.env.NODE_ENV === "production") throw new Error("Demos are dev-only.");
    const [{ generateSyntheticVocal }, { DEFECTS }] = await Promise.all([
      import("@/lib/dsp/defects/syntheticVocal"),
      import("@/lib/dsp/defects/injectors"),
    ]);
    let pcm = generateSyntheticVocal({ seed: 21, f0Base: 130 });
    const inj = (d: string, sev: "mild" | "moderate" | "severe") => (pcm = DEFECTS.find((x) => x.id === d)!.inject(pcm, sev, 1));
    if (id === "pops" || id === "dirty") inj("plosives", "moderate");
    if (id === "dirty") {
      inj("hum_60hz", "moderate");
      inj("clipping", "mild");
    }
    const b = new AudioBuffer({ length: pcm.channels[0]!.length, sampleRate: pcm.sampleRate, numberOfChannels: 1 });
    b.copyToChannel(pcm.channels[0]! as Float32Array<ArrayBuffer>, 0);
    return b;
  };

  return (
    <section className="space-y-2 rounded-lg border border-neutral-800 p-3">
      <h2 className="font-semibold">Source</h2>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept="audio/*"
          data-testid="file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void safe(f.name, async () => decode(await f.arrayBuffer()));
          }}
        />
        {process.env.NODE_ENV !== "production" &&
          DEMOS.map((d) => (
            <button key={d.id} className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600" data-testid={`demo-${d.id}`} onClick={() => void safe(d.label, () => demo(d.id))}>
              {d.label}
            </button>
          ))}
      </div>
      {fixtures.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-400">Fixtures (/fixtures/audio):</span>
          {fixtures.map((f) => (
            <button
              key={f}
              className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
              data-testid={`fixture-${f}`}
              onClick={() =>
                void safe(f, async () => {
                  const r = await fetch(`/api/fixtures/${encodeURIComponent(f)}`);
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  return decode(await r.arrayBuffer());
                })
              }
            >
              {f}
            </button>
          ))}
        </div>
      )}
      {source && (
        <p className="text-xs text-neutral-400">
          {source.name}: {source.buffer.duration.toFixed(1)} s, {source.buffer.sampleRate} Hz, {source.buffer.numberOfChannels} ch
          {source.buffer.numberOfChannels > 1 || source.buffer.sampleRate !== 48000 ? " (chain works on a 48 kHz mono copy)" : ""}
        </p>
      )}
      {err && <p className="text-xs text-red-400">{err}</p>}
      {busy && <p className="text-xs text-amber-400">{busy}...</p>}
    </section>
  );
}
