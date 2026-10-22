/*
 * MP3 encoding worker (classic worker, plain JS, deliberately NOT bundled or minified).
 * It loads lamejs 1.2.1 (LGPL-3.0, a JavaScript port of LAME) from its own unmodified file,
 * /vendor/lamejs/lame.all.js, so the library stays a separate, replaceable component.
 * Licence texts and source pointers: /licenses/ and third_party/lamejs/README.md.
 *
 * Message in : { pcm: Float32Array (mono), sampleRate, bitrateKbps, chunkSamples }
 * Message out: { ok: true, mp3: Uint8Array } | { ok: false, message }
 */
if (typeof importScripts === "function") importScripts("/vendor/lamejs/lame.all.js");

function encodeMp3(lame, pcm, sampleRate, bitrateKbps, chunkSamples) {
  var enc = new lame.Mp3Encoder(1, sampleRate, bitrateKbps);
  var parts = [];
  var total = 0;
  for (var i = 0; i < pcm.length; i += chunkSamples) {
    var n = Math.min(chunkSamples, pcm.length - i);
    var s16 = new Int16Array(n);
    for (var j = 0; j < n; j++) {
      var v = Math.max(-1, Math.min(1, pcm[i + j]));
      s16[j] = Math.round(v * 32767);
    }
    var b = enc.encodeBuffer(s16);
    if (b.length) { parts.push(b); total += b.length; }
  }
  var tail = enc.flush();
  if (tail.length) { parts.push(tail); total += tail.length; }
  var out = new Uint8Array(total);
  var o = 0;
  for (var k = 0; k < parts.length; k++) { out.set(parts[k], o); o += parts[k].length; }
  return out;
}

self.encodeMp3 = encodeMp3;
self.onmessage = function (e) {
  var d = e.data;
  try {
    var mp3 = encodeMp3(self.lamejs, d.pcm, d.sampleRate, d.bitrateKbps, d.chunkSamples);
    self.postMessage({ ok: true, mp3: mp3 }, [mp3.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, message: String(err && err.message ? err.message : err) });
  }
};
