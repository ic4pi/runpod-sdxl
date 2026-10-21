import { NextResponse } from "next/server";
import { listFixtures } from "@/lib/dsp/fixtures/loadFixtures";

export const dynamic = "force-dynamic";

/** Dev-only: lists files dropped into /fixtures/audio. 404 in production. */
export async function GET() {
  if (process.env.NODE_ENV === "production") return new NextResponse("Not found", { status: 404 });
  return NextResponse.json({ files: listFixtures() });
}
