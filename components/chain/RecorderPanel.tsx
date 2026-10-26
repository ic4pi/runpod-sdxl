"use client";

import { useEffect, useRef, useState } from "react";
import { useChain } from "@/lib/state/chainStore";

export function RecorderPanel() {
  const { loadSource } = useChain();
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [countIn, setCountIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied">("unknown");

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stopAll();
    };
  }, []);

  const stopAll = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    mediaStreamRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
  };

  const requestMic = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mediaStreamRef.current = stream;
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      setPermission("granted");
      startLevelMeter();
    } catch (e) {
      setPermission("denied");
      setError(e instanceof Error ? e.message : "Microphone access denied");
    }
  };

  const startLevelMeter = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, rms * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const playCountIn = async () => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    };
    const now = ctx.currentTime;
    beep(880, now, 0.1);
    beep(880, now + 0.5, 0.1);
    beep(880, now + 1.0, 0.1);
    beep(1320, now + 1.5, 0.2);
    await new Promise((r) => setTimeout(r, 1800));
  };

  const startRecording = async () => {
    if (!mediaStreamRef.current || !audioContextRef.current) await requestMic();
    if (!mediaStreamRef.current) return;
    setError(null);
    chunksRef.current = [];
    if (countIn) await playCountIn();
    const recorder = new MediaRecorder(mediaStreamRef.current, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const ctx = new AudioContext();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        await ctx.close();
        await loadSource(`recording-${Date.now()}.webm`, buffer);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to decode recording");
      }
      setRecording(false);
    };
    recorder.start();
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 p-3">
      <h2 className="font-semibold">Record vocal</h2>
      {permission === "unknown" && (
        <button className="rounded bg-neutral-700 px-3 py-1 text-sm hover:bg-neutral-600" onClick={() => void requestMic()}>
          Enable microphone
        </button>
      )}
      {permission === "denied" && <p className="text-xs text-red-400">Microphone access denied. Check browser permissions.</p>}
      {permission === "granted" && (
        <>
          <div className="flex items-center gap-3">
            <div className="h-2 w-32 overflow-hidden rounded bg-neutral-800">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${level * 100}%` }} />
            </div>
            <span className="text-xs text-neutral-400">Level</span>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} />
            Count-in (4 beeps)
          </label>
          {!recording ? (
            <button className="rounded bg-red-600 px-4 py-1.5 font-medium hover:bg-red-500" onClick={() => void startRecording()}>
              Start recording
            </button>
          ) : (
            <button className="rounded bg-neutral-600 px-4 py-1.5 font-medium hover:bg-neutral-500" onClick={stopRecording}>
              Stop
            </button>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
