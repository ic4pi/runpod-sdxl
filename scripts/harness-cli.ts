import { measureAll } from "../lib/dsp/measure";
import { buildCases, formatRowsText, runHarness, syntheticBases } from "../lib/dsp/defects/harness";

async function main() {
  const cases = buildCases(syntheticBases(), true);
  const t0 = Date.now();
  const result = await runHarness(cases, async (pcm, print) => measureAll(pcm, print));
  console.log(`cases: ${result.caseCount}, elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(formatRowsText(result.rows));
  console.log("\nper-case verdicts (F = fired, number = metric):");
  for (const o of result.outcomes) {
    const v = Object.values(o.verdicts)
      .map((d) => `${d.id}=${d.fired ? "F" : "."}(${d.metric.value.toFixed(4)})`)
      .join("  ");
    console.log(`${o.name.padEnd(28)} ${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
