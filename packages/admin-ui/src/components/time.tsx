import { formatTime } from "@/lib/time";

/** A time from the API, shown for people, with the exact value on hover. */
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {formatTime(value)}
    </time>
  );
}
