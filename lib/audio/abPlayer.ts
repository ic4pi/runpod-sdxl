/**
 * A/B playback of two PRE-RENDERED buffers. This is playback, not processing: both buffers are
 * already rendered offline. Both sources run in lockstep; switching only swaps gains (with a short
 * crossfade), so A and B stay sample-aligned and switching never restarts audio.
 */
export type Side = "original" | "processed";

export class AbPlayer {
  private ctx: AudioContext | null = null;
  private srcs: AudioBufferSourceNode[] = [];
  private gains: Record<Side, GainNode> | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;
  side: Side = "processed";
  onEnded: (() => void) | null = null;

  constructor(
    private buffers: Record<Side, AudioBuffer>,
    private matchGainDb: Record<Side, number>,
    private crossfadeMs: number,
  ) {}

  get duration(): number {
    return Math.max(this.buffers.original.duration, this.buffers.processed.duration);
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  get position(): number {
    if (!this.playing || !this.ctx) return this.offset;
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
  }

  setLevelMatch(db: Record<Side, number>): void {
    this.matchGainDb = db;
    this.applyGains();
  }

  private target(side: Side): number {
    return this.side === side ? Math.pow(10, this.matchGainDb[side] / 20) : 0;
  }

  private applyGains(): void {
    if (!this.ctx || !this.gains) return;
    const t = this.ctx.currentTime;
    for (const s of ["original", "processed"] as const) {
      const p = this.gains[s].gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(this.target(s), t + this.crossfadeMs / 1000);
    }
  }

  setSide(side: Side): void {
    this.side = side;
    this.applyGains();
  }

  async play(from = this.offset): Promise<void> {
    this.stopSources();
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    const ctx = this.ctx;
    this.gains = { original: ctx.createGain(), processed: ctx.createGain() };
    for (const s of ["original", "processed"] as const) {
      this.gains[s].gain.value = this.target(s);
      this.gains[s].connect(ctx.destination);
      const src = ctx.createBufferSource();
      src.buffer = this.buffers[s];
      src.connect(this.gains[s]);
      src.start(0, Math.min(from, this.buffers[s].duration));
      this.srcs.push(src);
    }
    this.srcs[0]!.onended = () => {
      if (this.playing && this.position >= this.duration - 0.05) {
        this.playing = false;
        this.offset = 0;
        this.onEnded?.();
      }
    };
    this.offset = from;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  pause(): void {
    this.offset = this.position;
    this.playing = false;
    this.stopSources();
  }

  async seek(sec: number): Promise<void> {
    const was = this.playing;
    this.offset = Math.max(0, Math.min(this.duration, sec));
    if (was) await this.play(this.offset);
  }

  private stopSources(): void {
    for (const s of this.srcs) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.srcs = [];
  }

  dispose(): void {
    this.playing = false;
    this.stopSources();
    void this.ctx?.close();
    this.ctx = null;
  }
}
