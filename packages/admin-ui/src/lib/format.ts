/** Short form of a hex digest for tables; the full value goes in a `title` and in details. */
export const shortHash = (hex: string): string => hex.slice(0, 12);
