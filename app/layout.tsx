import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vocal Repair",
  description: "Repair and polish phone-recorded rap vocals in your browser. Nothing leaves your device.",
  manifest: "/manifest.json",
  applicationName: "Vocal Repair",
  appleWebApp: { capable: true, title: "Vocal Repair", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#0a0a0a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
