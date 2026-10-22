import type { ReactNode } from "react";

/** Renders the Free page, then whatever the `@pro` slot provides. This file imports nothing from the Pro tree. */
export default function RepairLayout({ children, pro }: { children: ReactNode; pro: ReactNode }) {
  return (
    <>
      {children}
      <div className="mx-auto max-w-4xl px-4 pb-10 text-sm">{pro}</div>
    </>
  );
}
