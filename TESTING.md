# Testing — Phase 1 (measurement + defect harness)

## Setup
```
npm install
```

## 1. Unit tests (measurement correctness against known references)
```
npm test
```
Checks: BS.1770 reference (full-scale 1 kHz mono sine = -3.0 LUFS, 44.1/48 kHz), 20 dB step = 20 LU,
LRA of a 10 dB step, inter-sample true peak (fs/4 sine @45° reads ~0 dBTP vs -3 dB sample peak),
third-octave band of a known sine, crest 3.01 dB, correlation +1/-1, DC, clipping runs/overs,
noise floor/SNR recovery, and that every failure path throws (silence, NaN, short input, mono correlation,
missing/short/non-stationary noise print).

## 2. Defect harness in Node (fast, no browser)
```
npm run harness
```
Prints the per-detector precision/recall table and a per-case verdict list.

## 3. Defect harness in the browser (real Web Worker path)
```
npm run dev
# open http://localhost:3000/dev/defects  → "Run harness"
```
- Default: 4 generated vocals (F0 base 130/165/200/95 Hz) × (1 clean + 4 defects × 3 severities) = 52 cases.
- Optional: choose your own clean vocal file first. Noise print = quietest 2.5 s window; plosive injection
  points come from onset detection. Results are then n = 1 vocal, so precision/recall are weak evidence.
- The route 404s in production builds (`npm run build && npm start`).

## Reading the table
- `fires_on_defect`: detector fired on **every** injected variant of its own defect.
- `false_positive_on_control`: detector fired on **any** clean control.
- precision/recall: over all cases (a detector firing on another defect's injection counts as a false positive; `cross-fires` lists them). `n/a` = undefined, never a silent 0.
- Red cells in the per-case table = wrong verdicts.

## Reproducibility
Everything is seeded (mulberry32). Same code → same table. Typecheck: `npm run typecheck`.

## Caveat
Perfect scores on synthetic audio prove detector mechanics only. Every threshold is a placeholder
(`lib/dsp/measure/thresholds.ts`, `TODO: CALIBRATE`) and must be calibrated on real phone recordings.


---

# Phase 2 (repair chain, A/B, de-plosive confirm)

## Unit tests (Node)
```
npm test
```
Phase 2 suites: `expander` (gate / word tails), `deess`, `deplosive` (incl. clipped input), `noisePrint`, `rnnoise`,
`dynamics` (limiter, compressor), `config` (chain order + "no hardcoded numbers in stage files" lint), `native`
(pure helpers, level matching, peaks, WAV), `fixtures` (runs on your own recordings; skipped when none).

## Real-browser verification of the OfflineAudioContext stages and the UI
```
npm run e2e
```
Starts `next dev` itself, drives headless Chromium (`PW_EXE` or `/opt/pw-browsers`), and checks:
each native stage in a real `OfflineAudioContext` (HPF/EQ/saturation/space numbers), resample+downmix leaves the source untouched,
the full UI flow on a synthetic defective vocal (analysis -> pending pop confirmation -> render blocked -> confirm -> render ->
per-stage bypass -> level-matched A/B playback). Screenshots land in `e2e-out/`.

## Try it by hand
```
npm run dev      # http://localhost:3000/repair
```
Use a demo button, or drop your own recordings in `fixtures/audio/` (see its README) and click them under "Fixtures".
