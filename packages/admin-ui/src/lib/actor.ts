/** The system actor that seeds settings and profiles reads as "built-in" to people. */
export const actorName = (by: string): string => (by === "seed" ? "built-in" : by);

/** Seed rows carry the Unix epoch as their time; it says nothing, so it is not shown. */
export const isEpoch = (iso: string): boolean => new Date(iso).getTime() < Date.UTC(2000, 0, 1);
