export type DeliveryMethod = "share-sheet" | "download-link" | "open-in-tab";

const isIos = (): boolean =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Which method `deliverFile` will use on this device (for showing it in the UI before the tap). */
export function plannedDelivery(file: File): DeliveryMethod {
  if (isIos() && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) return "share-sheet";
  if (typeof document !== "undefined" && "download" in document.createElement("a")) return "download-link";
  return "open-in-tab";
}

/**
 * Must be called from a user gesture (a tap on "Save"): iOS Safari rejects navigator.share() without transient
 * activation, which would have expired during a multi-second render. So export is two taps: prepare, then save.
 * iOS: Web Share API (file share sheet -> "Save to Files"). Elsewhere: <a download>. Last resort: open the blob in a new tab.
 */
export async function deliverFile(blob: Blob, filename: string): Promise<DeliveryMethod> {
  const file = new File([blob], filename, { type: blob.type });
  const method = plannedDelivery(file);
  if (method === "share-sheet") {
    try {
      await navigator.share({ files: [file], title: filename });
      return "share-sheet";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "share-sheet"; // user closed the sheet
      // fall through to the next method
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    if ("download" in document.createElement("a")) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return "download-link";
    }
    window.open(url, "_blank");
    return "open-in-tab";
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
