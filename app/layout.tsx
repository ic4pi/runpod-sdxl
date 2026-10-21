import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Vocal Repair" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
