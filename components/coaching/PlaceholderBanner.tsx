import type { EvaluatedResult } from "@/lib/decision/evaluate";

/** Shown whenever the selected profile is flagged as placeholder: the numbers behind the deltas are invented. */
export function PlaceholderBanner({ profile }: { profile: EvaluatedResult["profile"] }) {
  if (!profile.placeholder) return null;
  return (
    <div className="rounded border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-200" data-testid="placeholder-banner">
      <p className="font-semibold">Placeholder reference: not measured data.</p>
      <p className="mt-1">
        The numbers behind &quot;{profile.label}&quot; were invented to exercise the engine. Treat every difference and every tip below as a demonstration, not
        as how real {profile.label.replace(" (placeholder)", "")} vocals sound.
      </p>
      <p className="mt-1 text-amber-300/80">{profile.basis}</p>
    </div>
  );
}
