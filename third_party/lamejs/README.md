# lamejs (MP3 encoder) — licence record and obligations

| | |
|---|---|
| Package | `lamejs` **1.2.1** (npm, pinned in `package.json` + `package-lock.json`) |
| SPDX (as declared by the package) | `LGPL-3.0` (`node_modules/lamejs/package.json`, `"license": "LGPL-3.0"`) |
| What the source files say | each `src/js/*.js` header: GNU Lesser General Public License, "version 2 of the License, or (at your option) any later version" (LGPL-2.0-or-later) |
| What it is | a JavaScript rewrite of jump3r, itself a Java port of LAME (libmp3lame) |
| Shipped file | `public/vendor/lamejs/lame.all.js` — byte-identical to the npm package's `lame.all.js` (sha256 `026bd88846040f357a937cd85821a48492a362eff0812cda734f23fca55fea3b`); a test (`tests/exportFormats.test.ts`) fails if it differs. It is the un-minified, readable form. |
| Licence texts shipped | `public/licenses/LGPL-3.0.txt`, `public/licenses/GPL-3.0.txt` (both from the SPDX license-list-data repository), `public/licenses/lamejs-LICENSE.txt` (the package's own LICENSE file, which is LAME's licensing note, not a licence text) |
| Notice page | `/licenses` in the app, linked from the app header and from the export panel when MP3 is chosen |

We use the library under LGPL-3.0 (the stricter reading; the source headers also permit 2.x).

## What the LGPL-3.0 asks of us when we convey the app, and what is done

1. **Say the library is used and is LGPL-covered** (§4a): the export panel, `/licenses`, and this file.
2. **Ship the licence texts** (§4b): LGPL-3.0 and the GPL-3.0 it incorporates are served from `/licenses/` and precached for offline use.
3. **Display the library's copyright notices if the app displays its own** (§4c): `/licenses` names LAME and lamejs and links upstream.
4. **Let users replace the library with a modified, interface-compatible version, and give them what they need to relink** (§4d): the encoder is a **separate, unmodified, unminified file** that a plain-JS worker (`public/workers/mp3-worker.js`) loads at run time with `importScripts`. It is not bundled or minified into the app code. Anyone running their own copy of the app swaps that file and the app uses it. The application itself is delivered to the browser as ordinary JavaScript, and the repository contains the full source and build steps (`npm run build`).
5. **Corresponding source of the library** (§4d.0 / §1): the shipped file is its own source (readable, unmodified); upstream is https://github.com/zhuker/lamejs and the LAME project (https://lame.sourceforge.io). We made no modifications, so there are no changes to publish.
6. We must not forbid modification for the customer's own use or reverse engineering to debug such modifications. The app imposes no such terms.

## What is NOT settled here

- This is an engineering reading of the licence, not legal advice. In particular, whether serving JavaScript to a browser is "conveying" in your jurisdiction, and what you must publish of your own app's source if you distribute it commercially, should be confirmed by a lawyer before launch. If you will not publish the application's source or object form, point 4 needs review.
- Patents: MP3 patents are widely reported to have expired (licensing programs ended in 2017). I did not verify that here.
- If you would rather not carry LGPL at all, the fallback is WAV-only: delete the MP3 option in `ExportPanel.tsx`, `public/workers/mp3-worker.js` and `public/vendor/lamejs/`.
