# Vocal Repair

Browser-only PWA that repairs and polishes phone-recorded rap vocals, records directly from the phone mic, and mixes against an imported beat. All audio processing runs client-side (Web Audio, RNNoise WASM); nothing is uploaded. An optional Pro tier rewords the coaching text with an LLM (`/api/phrasing`).

```
npm install
npm run dev          # development
npm run build        # production build (webpack) + precache manifest
npm test             # unit tests
npm run e2e          # browser checks (also e2e:coaching, e2e:pwa, e2e:pro); build first
```

## Features

- In-app microphone recording with level meter and optional count-in
- Full repair chain for phone-mic rap vocals
- Beat / instrumental import + simple mix and stereo WAV export
- Session persistence, PWA, A/B comparison, coaching

Pro tier environment (Vercel project settings):

| Variable | Purpose |
|---|---|
| `PRO_TOKEN_HASHES` | Pro keys (SHA-256 hashes, JSON list). Make one: `npm run rotate:pro-key -- --label owner` |
| `ANTHROPIC_API_KEY` | Model access direct from Anthropic, or |
| `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` | model access through OpenRouter |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) | shared rate-limit store (optional; per-instance memory otherwise) |

Design decisions: [DECISIONS.md](DECISIONS.md). What was tested and how: [TESTING.md](TESTING.md).

Real-audio calibration: see `fixtures/calibration/README.md`.
