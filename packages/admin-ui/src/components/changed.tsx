import { Time } from "@/components/time";
import { actorName, isEpoch } from "@/lib/actor";

/** "Last changed by alice 5 min ago"; a seed row has no real time, so it reads "Last changed by built-in". */
export function LastChanged({ by, at }: { by: string; at: string }) {
  return (
    <>
      Last changed by {actorName(by)}
      {!isEpoch(at) && (
        <>
          {" "}
          <Time value={at} />
        </>
      )}
    </>
  );
}

/** "5 min ago by alice", for a table cell; a seed row is just "built-in". */
export function ChangedCell({ by, at }: { by: string; at: string }) {
  if (isEpoch(at)) return <>{actorName(by)}</>;
  return (
    <>
      <Time value={at} /> by {actorName(by)}
    </>
  );
}
