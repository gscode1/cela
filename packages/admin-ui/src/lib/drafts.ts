/**
 * Unsaved form input of the later slices lives here, in memory, so that sign-out can drop it with the token and the
 * query cache. Nothing is written to browser storage.
 */
const drafts = new Map<string, unknown>();

export function setDraft(key: string, value: unknown): void {
  drafts.set(key, value);
}

export function getDraft(key: string): unknown {
  return drafts.get(key);
}

export function clearDrafts(): void {
  drafts.clear();
}
