import { useCallback, useState } from "react";
import { getDraft, setDraft } from "@/lib/drafts";

/**
 * A piece of component state that also lives in the in-memory drafts store, so an unsaved edit survives a trip to
 * another screen and is dropped on sign-out. `undefined` means no draft. The store holds `unknown`; the caller owns the
 * key and so the shape.
 */
export function useDraft<T>(key: string): [T | undefined, (value: T | undefined) => void] {
  const [value, setValue] = useState<T | undefined>(() => getDraft(key) as T | undefined);
  const update = useCallback(
    (next: T | undefined) => {
      setDraft(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, update];
}
