/** Pro key list (labels, issued_at), rotation without downtime, and the rotation script. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseProKeys, verifyProToken } from "../../lib/pro/auth";
import { sha256Hex } from "../../lib/pro/hash";
import { FakeLlm, okText, setup } from "./handlerHarness";
import { THREE_FINDINGS } from "./helpers";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe("parseProKeys", () => {
  it("JSON list with label and issued_at; legacy comma list of bare hashes still works", () => {
    const a = h("a"), b = h("b");
    const j = parseProKeys(JSON.stringify([{ hash: a, label: "launch", issued_at: "2026-10-22" }, { hash: b, label: "friend-1" }]));
    expect(j.errors).toEqual([]);
    expect(j.keys).toEqual([{ hash: a, label: "launch", issuedAt: "2026-10-22" }, { hash: b, label: "friend-1" }]);
    const legacy = parseProKeys(` ${a.toUpperCase()} , ${b} `);
    expect(legacy.errors).toEqual([]);
    expect(legacy.keys.map((k) => k.label)).toEqual([`key-${a.slice(0, 8)}`, `key-${b.slice(0, 8)}`]);
  });
  it("bad entries are skipped AND reported (never silently dropped): bad hash, duplicate, bad label, bad date, non-array, broken JSON", () => {
    const a = h("a");
    const r = parseProKeys(JSON.stringify([{ hash: "xyz", label: "x" }, { hash: a, label: "ok" }, { hash: a, label: "dup" }, { hash: h("c"), label: "bad/label" }, { hash: h("d"), label: "d", issued_at: "yesterday" }, 5]));
    expect(r.keys.map((k) => k.label)).toEqual(["ok"]);
    expect(r.errors.length).toBe(5);
    expect(parseProKeys("[{").errors[0]).toMatch(/does not parse/);
    expect(parseProKeys('{"hash":"x"}'.replace("{", "[").replace("}", "]")).errors.length).toBeGreaterThan(0);
    expect(parseProKeys(undefined)).toEqual({ keys: [], errors: [] });
  });
});

describe("verifyProToken", () => {
  it("returns the matching entry (so logs can say WHICH key was used); unknown, malformed and missing are distinguished", async () => {
    const keys = parseProKeys(JSON.stringify([{ hash: h("secret-key-one"), label: "one" }, { hash: h("secret-key-two"), label: "two" }])).keys;
    expect(await verifyProToken("Bearer secret-key-two", keys)).toEqual({ status: "ok", key: keys[1] });
    expect((await verifyProToken("Bearer secret-key-nine", keys)).status).toBe("invalid");
    expect((await verifyProToken("Basic abc", keys)).status).toBe("missing");
    expect((await verifyProToken(null, keys)).status).toBe("missing");
    expect((await verifyProToken("Bearer secret-key-one", [])).status).toBe("not-configured");
  });
});

describe("rotation through the handler", () => {
  it("old and new keys both work during the overlap; after the old hash is removed the old key gets 401 and the new one still works; the log names the key", async () => {
    const p = THREE_FINDINGS();
    const oldKey = "old-key-aaaaaaaaaaaa";
    const newKey = "new-key-bbbbbbbbbbbb";
    const entry = async (k: string, label: string) => ({ hash: await sha256Hex(k), label });
    const llm = new FakeLlm([okText(p)]);
    const during = await setup(llm, { proKeys: [await entry(oldKey, "old"), await entry(newKey, "new")] });
    expect((await during.call(p, { authorization: `Bearer ${oldKey}` })).status).toBe(200);
    expect((await during.call(p, { authorization: `Bearer ${newKey}` })).status).toBe(200); // cache hit, still authenticated first
    expect(during.logs.some((l) => l.key === "old")).toBe(true);
    const after = await setup(new FakeLlm([okText(p)]), { proKeys: [await entry(newKey, "new")] });
    expect((await after.call(p, { authorization: `Bearer ${oldKey}` })).status).toBe(401);
    expect((await after.call(p, { authorization: `Bearer ${newKey}` })).status).toBe(200);
  });
});

describe("scripts/rotate-pro-key.mjs (run for real)", () => {
  const run = (...a: string[]) => execFileSync("npx", ["tsx", "scripts/rotate-pro-key.mjs", ...a], { encoding: "utf8" });
  it("prints a key whose SHA-256 is the printed hash, and an env value the server's own parser accepts, keeping existing entries", () => {
    const first = run("--label", "launch");
    const key = /NEW KEY[^\n]*\n\s+(\S+)/.exec(first)![1]!;
    const hash = /hash:\s+(\S+)/.exec(first)![1]!;
    expect(key).toMatch(/^vrk_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(h(key));
    const env1 = first.split("\n").find((l) => l.startsWith("["))!;
    expect(parseProKeys(env1)).toMatchObject({ errors: [], keys: [{ hash, label: "launch" }] });

    const second = run("--label", "next", "--existing", env1);
    const env2 = second.split("\n").find((l) => l.startsWith("["))!;
    expect(parseProKeys(env2).keys.map((k) => k.label)).toEqual(["launch", "next"]);
    expect(second).toMatch(/no per-user keys|no billing/i);

    const removed = run("--remove", "launch", "--existing", env2);
    expect(parseProKeys(removed.split("\n").find((l) => l.startsWith("["))!).keys.map((k) => k.label)).toEqual(["next"]);
    expect(removed).toMatch(/revokes EVERY holder/);
  }, 60_000);
  it("refuses bad input: unknown label to remove, malformed existing value, invalid label", () => {
    for (const args of [["--remove", "ghost", "--existing", "[]"], ["--existing", "[{"], ["--label", "bad/label"]]) {
      expect(() => run(...args), args.join(" ")).toThrow();
    }
  }, 60_000);
});
