# RNNoise WASM (bundled)

| | |
|---|---|
| Used by | `lib/dsp/chain/rnnoise.ts` (noise reduction + the noise-print voice-activity check) |
| WASM file (served) | `public/wasm/rnnoise.wasm`, URL `/wasm/rnnoise.wasm` (config: `stages.noiseReduction.params.rnnoise.wasmUrl`) |
| WASM size | 112,141 bytes (~110 KiB), sha256 `677147b9248aedc0a00de79dc090d1ecead37c08c8bb773a790da16109d2c487` |
| JS glue (vendored) | `lib/dsp/chain/vendor/rnnoiseGlue.js` (emscripten loader, 12,265 bytes, unmodified) + `rnnoiseGlue.d.ts` (ours) |
| Source | npm `@jitsi/rnnoise-wasm@0.2.1` (`dist/rnnoise.js`, `dist/rnnoise.wasm`), copied verbatim |
| Licenses | Jitsi build/wrapper: Apache-2.0 (`LICENSE.jitsi-rnnoise-wasm.Apache-2.0`). RNNoise itself (Xiph.Org / Mozilla / Jean-Marc Valin): BSD-3-Clause (`LICENSE.xiph-rnnoise.BSD-3-Clause`, fetched from xiph/rnnoise `COPYING`). Both permit redistribution; no cost, no paid dependency. |
| Loading | Browser: the chain worker receives the bytes (fetched once from `wasmUrl`) and passes them as `wasmBinary` to the glue, so there is no path/`locateFile` resolution problem under Next.js. Node tests read the same file from disk. |
| Frame / rate | 480 samples at 48 kHz (10 ms), mono, 16-bit-range floats. Output delay 480 samples, compensated (`latencySamples`, verified by `tests/rnnoise.test.ts`). |

Not verified: which upstream RNNoise commit/model Jitsi compiled (it is the small original model, not the newer large-model builds).
No naive JS denoiser exists anywhere in the codebase; if the engine is missing the stage throws.
