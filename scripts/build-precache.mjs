// Run after `next build`: writes public/precache-manifest.js (list of every file the app needs offline + a version hash).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
if (!existsSync(".next/static") || !existsSync(".next/BUILD_ID")) throw new Error("Run `next build` first (.next/static or BUILD_ID missing).");

const hash = createHash("sha256");
hash.update(readFileSync(".next/BUILD_ID"));
const urls = ["/", "/repair", "/licenses"];

// Next's hashed build output: everything the pages, their dynamic imports and web workers load
for (const f of walk(".next/static").sort()) {
  if (f.endsWith(".map")) continue;
  if (f.split(path.sep).join("/").includes("/chunks/app/api/")) continue; // server route bundles (e.g. the Pro edge route) are never client assets
  urls.push("/" + path.posix.join("_next", path.relative(".next", f).split(path.sep).join("/")));
}

// Unhashed public files (content-hashed here so changing them changes the version)
const PUBLIC = ["manifest.json", "wasm/rnnoise.wasm", "workers/mp3-worker.js", "vendor/lamejs/lame.all.js", ...walk("public/icons").map((f) => path.relative("public", f).split(path.sep).join("/")), ...walk("public/licenses").map((f) => path.relative("public", f).split(path.sep).join("/"))];
for (const p of PUBLIC.sort()) {
  const buf = readFileSync(path.join("public", p));
  hash.update(p).update(buf);
  urls.push("/" + p);
}
const version = hash.digest("hex").slice(0, 16);
writeFileSync("public/precache-manifest.js", `self.__PRECACHE = ${JSON.stringify({ version, urls }, null, 2)};\n`);
console.log(`precache manifest: ${urls.length} files, version ${version}`);
