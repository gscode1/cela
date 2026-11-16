/** One JSON line per event on stdout. Never pass secrets in `fields`. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
