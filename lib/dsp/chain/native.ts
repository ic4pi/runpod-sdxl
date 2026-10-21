import { CHAIN_ORDER, STAGE_KIND, type ChainConfig, type StageId } from "../config";
import { isBypassed, type BypassMap } from "../configUtil";
import { makeRng } from "../rng";
import { db2lin } from "./dsp";

/**
 * Native stages: each segment is ONE OfflineAudioContext render (no live graph). The source
 * AudioBuffer is only ever read (as an AudioBufferSourceNode buffer); results are new buffers.
 */
export type NativeStageId = Extract<StageId, "hpf" | "eq" | "saturation" | "space">;
export const NATIVE_STAGE_IDS: readonly NativeStageId[] = CHAIN_ORDER.filter((id): id is NativeStageId => STAGE_KIND[id] === "native");

/** Web Audio's lowpass/highpass Q is in dB; config stores linear Q. */
export const linearQToDb = (q: number): number => 20 * Math.log10(q);

/** y = tanh(d x) / d, d = 10^(driveDb/20). Unity slope at 0. */
export function makeSaturationCurve(driveDb: number, size: number): Float32Array<ArrayBuffer> {
  const d = db2lin(driveDb);
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(d * x) / d;
  }
  return curve;
}

/** Deterministic reverb impulse response: seeded noise, exponential decay to decayDb at decaySec, one-pole damping, pre-delay. */
export function makeReverbIr(sampleRate: number, p: ChainConfig["stages"]["space"]["params"]["reverb"]): Float32Array<ArrayBuffer> {
  const pre = Math.round((p.preDelayMs / 1000) * sampleRate);
  const body = Math.round(p.decaySec * p.irLengthDecays * sampleRate);
  const ir = new Float32Array(pre + body);
  const rng = makeRng(p.irSeed);
  const slope = Math.abs(p.decayDb) / 20 / Math.log10(Math.E); // nepers over decaySec
  const damp = 1 - Math.exp((-2 * Math.PI * p.dampingHz) / sampleRate);
  let lp = 0;
  let energy = 0;
  for (let i = 0; i < body; i++) {
    lp += damp * (rng() * 2 - 1 - lp);
    const v = lp * Math.exp((-slope * i) / (p.decaySec * sampleRate));
    ir[pre + i] = v;
    energy += v * v;
  }
  const norm = 1 / Math.sqrt(energy || 1);
  for (let i = pre; i < ir.length; i++) ir[i] = ir[i]! * norm;
  return ir;
}

export function spaceTailSec(p: ChainConfig["stages"]["space"]["params"]): number {
  const rev = p.reverb.mix > 0 ? p.reverb.preDelayMs / 1000 + p.reverb.decaySec * p.reverb.irLengthDecays : 0;
  const del = p.delay.mix > 0 ? (p.delay.timeMs / 1000) * p.delay.tailRepeats : 0;
  return Math.min(p.tailPaddingSec, Math.max(rev, del)) || 0;
}

function addHpf(ctx: BaseAudioContext, input: AudioNode, p: ChainConfig["stages"]["hpf"]["params"]): AudioNode {
  let node = input;
  for (const q of p.qs) {
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = p.frequencyHz;
    f.Q.value = linearQToDb(q);
    node.connect(f);
    node = f;
  }
  return node;
}

function addEq(ctx: BaseAudioContext, input: AudioNode, p: ChainConfig["stages"]["eq"]["params"]): AudioNode {
  let node = input;
  for (const b of p.bands) {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.frequencyHz;
    f.gain.value = b.gainDb;
    f.Q.value = b.q;
    node.connect(f);
    node = f;
  }
  return node;
}

function addSaturation(ctx: BaseAudioContext, input: AudioNode, p: ChainConfig["stages"]["saturation"]["params"]): AudioNode {
  const dry = ctx.createGain();
  dry.gain.value = 1 - p.mix;
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeSaturationCurve(p.driveDb, p.curveSize);
  shaper.oversample = p.oversample;
  const wet = ctx.createGain();
  wet.gain.value = p.mix * db2lin(p.outputTrimDb);
  const sum = ctx.createGain();
  input.connect(dry).connect(sum);
  input.connect(shaper).connect(wet).connect(sum);
  return sum;
}

function addSpace(ctx: BaseAudioContext, input: AudioNode, p: ChainConfig["stages"]["space"]["params"]): AudioNode {
  const sum = ctx.createGain();
  input.connect(sum); // dry
  if (p.reverb.mix > 0) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const ir = makeReverbIr(ctx.sampleRate, p.reverb);
    const buf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
    buf.copyToChannel(ir, 0);
    conv.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = p.reverb.wetHighpassHz;
    const send = ctx.createGain();
    send.gain.value = p.reverb.mix;
    input.connect(conv).connect(hp).connect(send).connect(sum);
  }
  if (p.delay.mix > 0) {
    const d = ctx.createDelay(p.delay.timeMs / 1000 + 1);
    d.delayTime.value = p.delay.timeMs / 1000;
    const fb = ctx.createGain();
    fb.gain.value = p.delay.feedback;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = p.delay.lowpassHz;
    const send = ctx.createGain();
    send.gain.value = p.delay.mix;
    input.connect(d);
    d.connect(lp).connect(fb).connect(d);
    lp.connect(send).connect(sum);
  }
  return sum;
}

export interface NativeRenderResult {
  out: Float32Array;
  applied: NativeStageId[];
}

/**
 * Renders the non-bypassed `ids` (in the order given) as one OfflineAudioContext pass over `input`
 * (mono, `sampleRate`). Output may be longer than the input when reverb/delay tails are active.
 */
export async function renderNativeSegment(
  input: Float32Array,
  sampleRate: number,
  ids: readonly NativeStageId[],
  cfg: ChainConfig,
  bypass?: BypassMap,
): Promise<NativeRenderResult> {
  const active = ids.filter((id) => !isBypassed(cfg, id, bypass));
  if (active.length === 0) return { out: input, applied: [] };
  const tail = active.includes("space") ? Math.ceil(spaceTailSec(cfg.stages.space.params) * sampleRate) : 0;
  const ctx = new OfflineAudioContext(1, input.length + tail, sampleRate);
  const buf = ctx.createBuffer(1, input.length, sampleRate);
  buf.copyToChannel(Float32Array.from(input), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;
  for (const id of active) {
    if (id === "hpf") node = addHpf(ctx, node, cfg.stages.hpf.params);
    else if (id === "eq") node = addEq(ctx, node, cfg.stages.eq.params);
    else if (id === "saturation") node = addSaturation(ctx, node, cfg.stages.saturation.params);
    else node = addSpace(ctx, node, cfg.stages.space.params);
  }
  node.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return { out: rendered.getChannelData(0).slice(), applied: active };
}

/**
 * Resample to the internal rate and downmix to mono in one OfflineAudioContext render.
 * `src` is only read. Returns a new Float32Array.
 */
export async function prepareMono(src: AudioBuffer, targetRate: number): Promise<Float32Array> {
  if (src.sampleRate === targetRate && src.numberOfChannels === 1) return src.getChannelData(0).slice();
  const length = Math.ceil(src.duration * targetRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: targetRate });
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination); // destination is mono: Web Audio's speaker-layout down-mix averages L/R
  node.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}
