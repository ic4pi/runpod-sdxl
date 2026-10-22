/** scripts/measure-real-audio.mjs: argument handling, and the guard that no audio file is ever committed. (The full run needs a build + Chromium: see TESTING.md.) */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fails = async (args: string[]) => {
  try {
    await run("npx", ["tsx", "scripts/measure-real-audio.mjs", ...args], { encoding: "utf8", timeout: 60_000 });
    return null;
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    return { code: err.code, stderr: err.stderr ?? "" };
  }
};

describe("measure-real-audio.mjs", () => {
  it("no argument -> usage and exit 1; missing file -> exit 1 naming the file", async () => {
    const a = await fails([]);
    expect(a?.code).toBe(1);
    expect(a?.stderr).toMatch(/Usage: npx tsx scripts\/measure-real-audio\.mjs/);
    const b = await fails(["definitely-not-here.wav"]);
    expect(b?.code).toBe(1);
    expect(b?.stderr).toMatch(/No such file: definitely-not-here\.wav/);
  }, 90_000);

  it("NO audio file is tracked by git, and the harness output directory is git-ignored", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => /\.(wav|mp3|flac|m4a|ogg|aiff?)$/i.test(f));
    expect(tracked).toEqual([]);
    expect(execFileSync("git", ["check-ignore", "measure-out/x.wav"], { encoding: "utf8" }).trim()).toBe("measure-out/x.wav");
  });
});
