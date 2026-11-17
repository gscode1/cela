/**
 * Times for people: "just now", "5 min ago", "3 h ago" within a day, then the local date and time. The API's ISO
 * string stays available for a `title`, so the exact value is one hover away.
 */
export function formatTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds >= 0 && seconds < 45) return "just now";
  if (seconds >= 0 && seconds < 3600)
    return `${String(Math.max(1, Math.round(seconds / 60)))} min ago`;
  if (seconds >= 0 && seconds < 86_400) return `${String(Math.round(seconds / 3600))} h ago`;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
