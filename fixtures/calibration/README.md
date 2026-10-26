# Real-audio calibration

Place real phone-mic rap vocal recordings (WAV preferred, 48 kHz mono or stereo) in this folder for calibration.

## Recommended set

- Clean takes (quiet room, no obvious defects)
- Takes with plosives / pops
- Takes with room noise / hiss
- Clipped takes
- Different voices (male / female, various ages)
- Different phone mics if possible

## How to use

1. Drop files here.
2. Run `npm run measure:real -- fixtures/calibration/yourfile.wav` (or the harness) to collect measurements.
3. Adjust thresholds in `lib/dsp/config.ts`, `lib/dsp/measure/thresholds.ts`, and genre profiles based on the results.
4. Update the `_placeholder` flags once calibrated.

All current thresholds and profiles are synthetic placeholders until this is done.
