import { type Pcm, type Quantity, assertPcm, lin2db, q } from "./types";

export interface DcOffsetResult {
  /** Mean of each channel, fraction of full scale (signed). */
  perChannel: Quantity<"FS">[];
  /** Largest |mean| across channels. */
  maxAbs: Quantity<"FS">;
  maxAbsDb: Quantity<"dBFS">;
}

export function measureDcOffset(pcm: Pcm): DcOffsetResult {
  assertPcm(pcm);
  const perChannel = pcm.channels.map((ch) => {
    let s = 0;
    for (let i = 0; i < ch.length; i++) s += ch[i]!;
    return q(s / ch.length, "FS");
  });
  const maxAbs = Math.max(...perChannel.map((c) => Math.abs(c.value)));
  return { perChannel, maxAbs: q(maxAbs, "FS"), maxAbsDb: q(lin2db(maxAbs), "dBFS") };
}
