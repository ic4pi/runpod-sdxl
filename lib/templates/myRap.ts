import { validateTemplate } from "./validate";
import type { Template } from "./types";

/**
 * Taste template: the owner's reference clips, all switched on. `measured: null` means "not measured yet"; every number that
 * is present was measured from the owner's own copy of that clip. Nothing comes from memory or estimate.
 */
export const myRap: Template = validateTemplate({
  id: "my-rap",
  label: "My rap taste (free BandLab)",
  version: 1,
  tier: "free",
  targetScope: "full-mix",
  preset: "neutral",
  references: [
    // Measured 2026-11-06 from the owner's own 128 kbps / 32 kHz MP3 copies, decoded to 48 kHz and run through lib/dsp/measure
    // on the whole clip. Labels are neutral on purpose: these clips only map levels.
    { id: "ref-1", label: "Reference 1", enabled: true, measured: { integrated_lufs: -8.26, lra_lu: 5.89, true_peak_dbtp: 1.73, crest_active_db: 10.87, boxiness_250hz_rel_db: -18.4, presence_3k5_rel_db: -20.42, sibilance_5k9k_rel_db: -19.41 } },
    { id: "ref-2", label: "Reference 2", enabled: true, measured: { integrated_lufs: -9.36, lra_lu: 8.03, true_peak_dbtp: 0.43, crest_active_db: 12.22, boxiness_250hz_rel_db: -14.12, presence_3k5_rel_db: -14.48, sibilance_5k9k_rel_db: -13.63 } },
    { id: "ref-3", label: "Reference 3", enabled: true, measured: { integrated_lufs: -9.41, lra_lu: 2.89, true_peak_dbtp: 0.63, crest_active_db: 12.71, boxiness_250hz_rel_db: -12.01, presence_3k5_rel_db: -15.31, sibilance_5k9k_rel_db: -15.1 } },
    { id: "ref-4", label: "Reference 4", enabled: true, measured: { integrated_lufs: -4.93, lra_lu: 2.89, true_peak_dbtp: 2, crest_active_db: 8.82, boxiness_250hz_rel_db: -17.68, presence_3k5_rel_db: -12.07, sibilance_5k9k_rel_db: -14.03 } },
    { id: "ref-5", label: "Reference 5", enabled: true, measured: { integrated_lufs: -8.56, lra_lu: 2.31, true_peak_dbtp: -0.15, crest_active_db: 9.91, boxiness_250hz_rel_db: -12.23, presence_3k5_rel_db: -20.55, sibilance_5k9k_rel_db: -20.39 } },
  ],
  steps: [
    {
      id: "beat",
      where: "bandlab",
      title: "Start the project and add your beat",
      do: "Create a new project in BandLab and import the beat you uploaded. Note its tempo.",
      bandlabUnverified: true,
    },
    {
      id: "record",
      where: "bandlab",
      title: "Record vocals dry",
      do: "Wear headphones so the beat does not leak into the mic. Record every take with no BandLab effects or auto-pitch on the vocal track. The repair step works best on a dry recording.",
      bandlabUnverified: true,
    },
    {
      id: "export-vocal",
      where: "bandlab",
      title: "Get the dry vocal out",
      do: "Export the vocal track alone. If the free tier will not export a single track, mute the beat and export the mix instead, or record in this app (Record panel) and import the beat there.",
      bandlabUnverified: true,
    },
    {
      id: "repair",
      where: "app",
      title: "Repair the vocal",
      do: "Load the vocal in the app, pick a preset, confirm or skip each flagged plosive, listen with A/B, then export WAV.",
    },
    {
      id: "mix",
      where: "bandlab",
      title: "Put it back and balance it",
      do: "Import the repaired vocal as a new track and set vocal level against the beat by ear. Keep the effects you add on the vocal minimal: reverb and delay amounts are what the final check will flag.",
      bandlabUnverified: true,
    },
    {
      id: "check",
      where: "app",
      title: "Check the mix against your taste",
      do: "Export the full mix, load it in the app and compare it to your reference range. The app reports where you sit inside or outside the range of the songs you enabled.",
      check: ["integrated_lufs", "lra_lu", "true_peak_dbtp", "crest_active_db", "boxiness_250hz_rel_db", "presence_3k5_rel_db", "sibilance_5k9k_rel_db"],
    },
  ],
  unverified: [
    "BandLab menu names and button labels are not confirmed.",
    "Whether the free tier exports a single track is not confirmed.",
    "The reference clips are 128 kbps MP3 copies, so true peak can read above 0 dBTP and is not a sign of a bad master.",
    "The vocal presets are placeholders until calibrated on real recordings.",
  ],
});
