const FILES = [
  ["lamejs 1.2.1 (MP3 encoder, JavaScript port of LAME): LGPL-3.0 (source headers: LGPL v2 or later)", "/licenses/LGPL-3.0.txt"],
  ["GNU GPL v3 (incorporated by the LGPL v3)", "/licenses/GPL-3.0.txt"],
  ["lamejs licence note shipped with the package", "/licenses/lamejs-LICENSE.txt"],
  ["RNNoise (Xiph.Org / Mozilla): BSD-3-Clause", "/licenses/rnnoise-BSD-3-Clause.txt"],
  ["RNNoise WASM build by Jitsi: Apache-2.0", "/licenses/jitsi-rnnoise-wasm-Apache-2.0.txt"],
] as const;

export const metadata = { title: "Licenses" };

export default function Licenses() {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 text-sm">
      <h1 className="text-lg font-semibold">Open-source notices</h1>
      <p className="text-neutral-300">
        <strong>MP3 export</strong> uses <strong>lamejs 1.2.1</strong>, a JavaScript port of the LAME MP3 encoder, licensed under the GNU Lesser General Public License v3.0 (its source files state LGPL v2 or later).
        It is served as a separate, unmodified, human-readable file (<a className="underline" href="/vendor/lamejs/lame.all.js">/vendor/lamejs/lame.all.js</a>) that the encoder worker loads at run time, so it can be replaced by a modified, interface-compatible version. Its source is the same file; upstream:{" "}
        <a className="underline" href="https://github.com/zhuker/lamejs">github.com/zhuker/lamejs</a>, LAME: <a className="underline" href="https://lame.sourceforge.io">lame.sourceforge.io</a>.
      </p>
      <p className="text-neutral-300">
        <strong>Noise reduction</strong> uses RNNoise compiled to WebAssembly (<a className="underline" href="/wasm/rnnoise.wasm">/wasm/rnnoise.wasm</a>).
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {FILES.map(([label, href]) => (
          <li key={href}>
            <a className="underline" href={href}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
