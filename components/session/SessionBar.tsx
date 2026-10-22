"use client";

import { useEffect } from "react";
import { useChain } from "@/lib/state/chainStore";
import { useSessions } from "@/lib/state/sessionStore";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** Saved sessions (IndexedDB), autosave status, and the interrupted-render recovery prompt. */
export function SessionBar() {
  const { ready, sessions, currentId, lastSavedAt, interrupted, persisted, usage, error, init, saveNow, openSession, removeSession, resumeInterrupted, dismissInterrupted } = useSessions();
  const hasSource = useChain((s) => s.source !== null);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <section className="space-y-2 rounded-lg border border-neutral-800 p-3" data-testid="session-section">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Sessions</h2>
        {hasSource && (
          <button className="rounded bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600" onClick={() => void saveNow()} data-testid="save-session">
            Save now
          </button>
        )}
        <span className="text-xs text-neutral-500" data-testid="save-status">
          {!ready ? "Storage not available" : lastSavedAt ? `Autosaved ${ago(lastSavedAt)}` : hasSource ? "Autosaves a moment after each change" : "Nothing to save yet"}
        </span>
        {usage && (
          <span className="text-xs text-neutral-600">
            Using {mb(usage.usage)} of {mb(usage.quota)} {persisted ? "(persistent)" : "(may be cleared by the browser)"}
          </span>
        )}
      </div>
      {interrupted && (
        <div className="rounded border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-200" data-testid="interrupted-banner">
          <p>
            A render of “{interrupted.name}” was interrupted (the page was closed or suspended). A render cannot be resumed mid-way: it can be re-run from the saved
            source and settings.
          </p>
          <div className="mt-1 flex gap-2">
            <button className="rounded bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500" onClick={() => void resumeInterrupted()} data-testid="resume-render">
              Restore and re-render
            </button>
            <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={() => void dismissInterrupted()}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-400" data-testid="session-error">{error}</p>}
      {sessions.length > 0 && (
        <ul className="divide-y divide-neutral-900 text-xs" data-testid="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-1" data-session={s.id}>
              <span className={`min-w-0 flex-1 truncate ${s.id === currentId ? "text-emerald-400" : ""}`}>{s.name}</span>
              <span className="text-neutral-500">{s.presetId} · {s.durationSec.toFixed(0)} s · {mb(s.bytes)} · {ago(s.updatedAt)}</span>
              <button className="rounded bg-neutral-700 px-2 py-0.5 hover:bg-neutral-600" onClick={() => void openSession(s.id)} data-testid="open-session">
                Open
              </button>
              <button className="rounded px-2 py-0.5 text-neutral-400 hover:text-red-400" onClick={() => void removeSession(s.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
