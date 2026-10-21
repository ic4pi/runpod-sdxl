import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { FIXTURE_DIR, listFixtures } from "@/lib/dsp/fixtures/loadFixtures";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
  ".opus": "audio/ogg", ".flac": "audio/flac", ".caf": "audio/x-caf", ".webm": "audio/webm", ".mp4": "audio/mp4",
};

/** Dev-only. Only names that appear in the fixture listing are served (no path traversal). */
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse("Not found", { status: 404 });
  const { name } = await ctx.params;
  if (!listFixtures().includes(name)) return new NextResponse("Not found", { status: 404 });
  const bytes = await readFile(/*turbopackIgnore: true*/ path.join(FIXTURE_DIR, name));
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream" } });
}
