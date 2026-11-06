import { validateTemplate } from "./validate";
import type { Template } from "./types";

/**
 * Taste template: the owner's references, all switched on, none measured yet. `measured: null` means "not measured";
 * no number here comes from memory or estimate. Fill them by measuring your own copy of each song.
 */
export const myRap: Template = validateTemplate({
  id: "my-rap",
  label: "My rap taste (free BandLab)",
  version: 1,
  tier: "free",
  targetScope: "full-mix",
  preset: "neutral",
  references: [
    { id: "joyner-lucas-lotto", artist: "Joyner Lucas", track: "Lotto", enabled: true, measured: null },
    { id: "kendrick-lamar-adhd", artist: "Kendrick Lamar", track: "ADHD", enabled: true, measured: null },
    { id: "three-6-mafia-stay-fly", artist: "Three 6 Mafia", track: "Stay Fly", enabled: true, measured: null },
    { id: "pell-the-never", artist: "Pell", track: "The Never", enabled: true, measured: null },
    { id: "vinny-paz-pick", artist: "Vinny Paz", track: null, enabled: true, measured: null },
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
    "No reference song has been measured yet, so there are no taste targets yet.",
    "The vocal presets are placeholders until calibrated on real recordings.",
  ],
});
