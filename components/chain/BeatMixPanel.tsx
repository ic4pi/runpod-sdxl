"use client";

import { useState } from "react";
import { useChain } from "@/lib/state/chainStore";

export function BeatMixPanel() {
  const { result, cfg, metadata, exportFormat } = useChain();
  const [beat, setBeat] = useState<AudioBuffer | null>(null);
  const [beatName, setBeatName] = useState<string>("");
  const [vocalGain, setVocalGain] = useState(0);
  const [beatGain, setBeatGain] = useState(-3);
  const [sidechain, setSidechain] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mixUrl, setMixUrl] = useState<string | null>(null);

  const loadBeat = async (file: File) => {
    setError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      await ctx.close();
      setBeat(buffer);
      setBeatName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decode beat");
    }
  };

  const mixAndExport = async () => {
    if (!result?.processed || !beat) return;
    setWorking(true);
    setError(null);
    setMixUrl(null);
    try {
      const vocal = result.processed;
      const sampleRate = 48000;
      const length = Math.max(vocal.length, beat.length);
      const offline = new OfflineAudioContext(2, length, sampleRate);

      // Vocal (mono) to both channels with gain
      const vocalSrc = offline.createBufferSource();
      vocalSrc.buffer = vocal;
      const vocalGainNode = offline.createGain();
      vocalGainNode.gain.value = Math.pow(10, vocalGain / 20);
      vocalSrc.connect(vocalGainNode);
      vocalGainNode.connect(offline.destination);

      // Beat (stereo or mono)
      const beatSrc = offline.createBufferSource();
      beatSrc.buffer = beat;
      const beatGainNode = offline.createGain();
      beatGainNode.gain.value = Math.pow(10, beatGain / 20);
      beatSrc.connect(beatGainNode);

      if (sidechain && vocal.length > 0) {
        // Simple sidechain: compress beat when vocal is loud (basic envelope follower)
        const compressor = offline.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.01;
        compressor.release.value = 0.15;
        // Use vocal as sidechain via analyser-like peak, but OfflineAudioContext doesn't support sidechain natively easily.
        // Approximate with a gain automation based on vocal RMS (simplified).
        // For now, connect beat through compressor (self-sidechain as placeholder; full sidechain needs more work).
        beatGainNode.connect(compressor);
        compressor.connect(offline.destination);
      } else {
        beatGainNode.connect(offline.destination);
      }

      vocalSrc.start(0);
      beatSrc.start(0);
      const rendered = await offline.startRendering();

      // Simple WAV export for the mix (stereo)
      const wav = audioBufferToWav(rendered);
      const blob = new Blob([wav], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      setMixUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mix failed");
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 p-3">
      <h2 className="font-semibold">Beat / mix</h2>
      <div>
        <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && void loadBeat(e.target.files[0])} />
        {beatName && <p className="mt-1 text-xs text-neutral-400">Loaded: {beatName} ({beat?.duration.toFixed(1)}s)</p>}
      </div>
      {beat && result?.processed && (
        <>
          <label className="block text-xs">
            Vocal gain: {vocalGain} dB
            <input type="range" min={-12} max={12} step={0.5} value={vocalGain} onChange={(e) => setVocalGain(Number(e.target.value))} className="w-full" />
          </label>
          <label className="block text-xs">
            Beat gain: {beatGain} dB
            <input type="range" min={-12} max={6} step={0.5} value={beatGain} onChange={(e) => setBeatGain(Number(e.target.value))} className="w-full" />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={sidechain} onChange={(e) => setSidechain(e.target.checked)} />
            Simple sidechain (approx)
          </label>
          <button
            className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
            disabled={working}
            onClick={() => void mixAndExport()}
          >
            {working ? "Mixing…" : "Mix & prepare WAV"}
          </button>
        </>
      )}
      {mixUrl && (
        <a href={mixUrl} download={`${metadata.artist || "artist"}_${metadata.track || "track"}_mix.wav`} className="block text-sm text-emerald-400 underline">
          Download mixed track (WAV)
        </a>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <p className="text-xs text-neutral-500">Import a beat (WAV/MP3 from BandLab or elsewhere). Mix is a simple stereo bounce. Full sidechain and advanced mixing coming later.</p>
    </section>
  );
}

/** Minimal stereo WAV writer (16-bit PCM). */
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const bufferSize = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: numChannels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c]![i]!));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return arrayBuffer;
}
