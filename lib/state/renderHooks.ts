/** Lets the session store observe renders without the chain store importing it (avoids a cycle). Hook failures never break a render. */
export interface RenderHooks {
  /** Called when a render starts; returns an id to pass to `end`. */
  begin?: () => Promise<string | null>;
  end?: (id: string | null, ok: boolean, error?: string) => Promise<void>;
}
export const renderHooks: RenderHooks = {};
