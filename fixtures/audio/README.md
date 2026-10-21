# Real-recording fixtures

Drop phone-mic vocal recordings here. No code changes needed.

## Accepted
- **In the browser UI (`/repair`)**: anything the browser can decode: WAV, MP3, M4A/AAC (iPhone Voice Memos), OGG/Opus, FLAC, CAF, WebM. Any sample rate, mono or stereo (the chain works on a 48 kHz mono copy; the file itself is never modified).
- **In `npm test` (`tests/fixtures.test.ts`)**: **WAV only** (16/24/32-bit PCM or 32/64-bit float), and only **48 kHz**: Node has no resampler, so other rates are listed and skipped with the reason. Convert once with e.g. `ffmpeg -i in.m4a -ar 48000 -ac 1 out.wav`.

## Recommended recording to drop in
- 20-60 s of rap vocal, raw (no plugins, no normalising, no noise reduction already applied).
- Starts with **at least 2.5 s of room silence** (that becomes the noise print). If it doesn't, the UI auto-picks the quietest 2.5 s window and tells you whether it was accepted.
- Mono is fine. Keep the level as recorded.
- Name it descriptively, e.g. `iphone-bedroom-fan.wav`, `android-clipped-hook.wav`.

## How to use
1. Copy files into this folder (they are git-ignored; recordings are not committed).
2. `npm run dev`, open `http://localhost:3000/repair`: your files appear under "Fixtures (/fixtures/audio)". Click one.
3. `npm test`: each usable WAV runs analysis plus the sample-domain stages and logs one summary line per file.

The `/api/fixtures` routes that list and serve this folder exist only in development (they 404 in production builds).
