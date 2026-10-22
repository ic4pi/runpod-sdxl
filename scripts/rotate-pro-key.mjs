// Pro key rotation helper. Run with tsx (it reuses the server's own parser, so what it prints is exactly what the server accepts):
//   npx tsx scripts/rotate-pro-key.mjs [--label NAME] [--existing "$PRO_TOKEN_HASHES"]     generate a key + the env value to deploy
//   npx tsx scripts/rotate-pro-key.mjs --remove NAME --existing "$PRO_TOKEN_HASHES"        print the env value without entry NAME
// The key is printed ONCE and never stored; only its SHA-256 hash goes in the environment.
import { createHash, randomBytes } from "node:crypto";
import { parseProKeys } from "../lib/pro/auth.ts";
import { PRO_CONFIG } from "../lib/pro/config.ts";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const existing = parseProKeys(opt("existing"));
if (existing.errors.length) {
  console.error("The --existing value has problems; fix them first:\n  " + existing.errors.join("\n  "));
  process.exit(1);
}
const asEnv = (keys) => JSON.stringify(keys.map((k) => ({ hash: k.hash, label: k.label, ...(k.issuedAt ? { issued_at: k.issuedAt } : {}) })));

const remove = opt("remove");
if (remove) {
  const left = existing.keys.filter((k) => k.label !== remove);
  if (left.length === existing.keys.length) {
    console.error(`No entry labelled "${remove}". Labels present: ${existing.keys.map((k) => k.label).join(", ") || "(none)"}`);
    process.exit(1);
  }
  console.log(`Removing "${remove}" revokes EVERY holder of that key (there are no per-user keys).\n`);
  console.log("New PRO_TOKEN_HASHES value:\n" + asEnv(left));
  if (left.length === 0) console.log("\nWARNING: this leaves no keys, so /api/phrasing answers 503 to everyone until you add one.");
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);
const label = opt("label") ?? `key-${today}`;
const key = `vrk_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const entry = { hash, label, issuedAt: today };
const probe = parseProKeys(asEnv([entry]));
if (probe.errors.length) {
  console.error("That label is not valid: " + probe.errors.join("; "));
  process.exit(1);
}

console.log(`NEW KEY (shown once; give it to the user, do not commit it):\n  ${key}\n`);
console.log(`hash:   ${hash}\nlabel:  ${label}\nissued: ${today}\n`);
console.log("PRO_TOKEN_HASHES value to deploy (existing entries kept, new one added, so old and new both work during the overlap):");
console.log(asEnv([...existing.keys, entry]) + "\n");
console.log(`Rotation steps
  1. Set PRO_TOKEN_HASHES to the value above (Vercel: Project -> Settings -> Environment Variables) and redeploy.
  2. Give the new key to its holders; they paste it in the Pro panel ("Pro key") on /repair.
  3. When nobody should use the old key any more, run:
       npx tsx scripts/rotate-pro-key.mjs --remove <old-label> --existing '<current value>'
     deploy that value, and the old key is dead (the server answers 401 to it).
Honest limits: no billing, no per-user keys, no expiry enforcement. Removing a hash revokes everyone holding that key; issued_at is informational. A leaked key
is capped only by the per-key rate limit (${PRO_CONFIG.rateLimit.perKey}/hour) until you remove its hash.`);
