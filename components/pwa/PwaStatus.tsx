"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Registers the service worker (production only), reports offline readiness, shows the real install prompt (Android/desktop Chrome) or iOS instructions. */
export function PwaStatus() {
  const [online, setOnline] = useState(true);
  const [offlineReady, setOfflineReady] = useState<{ files: number } | null>(null);
  const [swError, setSwError] = useState<string | null>(null);
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    setInstalled(isStandalone());
    setIos(isIos());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    const bip = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
      (window as unknown as { __bipFired?: boolean }).__bipFired = true;
    };
    const installedEv = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("beforeinstallprompt", bip);
    window.addEventListener("appinstalled", installedEv);

    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(async (reg) => {
          if (reg.waiting && navigator.serviceWorker.controller) setUpdate(reg);
          reg.addEventListener("updatefound", () => {
            const w = reg.installing;
            w?.addEventListener("statechange", () => {
              if (w.state === "installed" && navigator.serviceWorker.controller) setUpdate(reg);
            });
          });
          await navigator.serviceWorker.ready;
          const ask = () => {
            const sw = navigator.serviceWorker.controller ?? reg.active;
            if (!sw) return;
            const ch = new MessageChannel();
            ch.port1.onmessage = (m) => m.data?.type === "STATUS" && setOfflineReady({ files: m.data.cached });
            sw.postMessage({ type: "STATUS" }, [ch.port2]);
          };
          ask();
          navigator.serviceWorker.addEventListener("controllerchange", ask);
        })
        .catch((e) => setSwError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("beforeinstallprompt", bip);
      window.removeEventListener("appinstalled", installedEv);
    };
  }, []);

  return (
    <section className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="pwa-status">
      <span className={online ? "text-emerald-400" : "text-amber-400"} data-testid="net-status">
        {online ? "Online" : "Offline"}
      </span>
      {offlineReady && (
        <span className="text-emerald-400" data-testid="offline-ready">
          Works offline ({offlineReady.files} files cached, including the RNNoise denoiser)
        </span>
      )}
      {swError && <span className="text-red-400">Offline support failed to start: {swError}</span>}
      {process.env.NODE_ENV !== "production" && <span className="text-neutral-600">dev build: service worker disabled</span>}
      {update && (
        <button
          className="rounded bg-amber-600 px-2 py-0.5 text-white"
          onClick={() => {
            update.waiting?.postMessage({ type: "SKIP_WAITING" });
            navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
          }}
        >
          Update ready: reload
        </button>
      )}
      {installed ? (
        <span className="text-neutral-400">Running as an installed app</span>
      ) : prompt ? (
        <button
          className="rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-500"
          data-testid="install-button"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice;
            setPrompt(null);
          }}
        >
          Install app
        </button>
      ) : ios ? (
        <span className="text-neutral-400" data-testid="ios-hint">
          iPhone/iPad: tap Share, then “Add to Home Screen”. Safari has no install prompt.
        </span>
      ) : null}
      <a className="text-neutral-500 underline" href="/licenses">
        Licenses
      </a>
    </section>
  );
}
