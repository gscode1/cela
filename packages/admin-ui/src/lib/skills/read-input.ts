import type { RawEntry } from "@/lib/skills/bundle";
import { SKILL_LIMITS } from "@/lib/skills/limits";
import { unpackZip } from "@/lib/skills/zip";

/**
 * Entries of a folder chosen with `<input webkitdirectory>`. The browser cannot tell the executable bit, so it is
 * `undefined` and set in the review step. Paths come from `webkitRelativePath` (`folder/sub/file`).
 */
export async function readFolder(files: readonly File[]): Promise<RawEntry[]> {
  let total = 0;
  for (const file of files) total += file.size;
  if (total > SKILL_LIMITS.bytes * 4)
    throw new Error("that folder is far over the 5 MiB limit; pick the skill's own folder");
  const entries: RawEntry[] = [];
  for (const file of files) {
    const relative = file.webkitRelativePath === "" ? file.name : file.webkitRelativePath;
    entries.push({
      path: relative,
      bytes: new Uint8Array(await file.arrayBuffer()),
      executable: undefined,
    });
  }
  return entries;
}

export async function readZipFile(file: File): Promise<RawEntry[]> {
  return unpackZip(new Uint8Array(await file.arrayBuffer()), SKILL_LIMITS.bytes);
}
