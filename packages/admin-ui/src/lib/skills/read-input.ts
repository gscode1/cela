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

/** The name of a zip without its extension: the skill's name when nothing else says it. */
export const zipBaseName = (fileName: string): string => fileName.replace(/\.zip$/i, "");

const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });

async function listDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(
  entry: FileSystemEntry,
  into: RawEntry[],
  budget: { left: number },
): Promise<void> {
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    budget.left -= file.size;
    if (budget.left < 0)
      throw new Error("that folder is far over the 5 MiB limit; pick the skill's own folder");
    into.push({
      path: entry.fullPath.replace(/^\//, ""),
      bytes: new Uint8Array(await file.arrayBuffer()),
      executable: undefined,
    });
    return;
  }
  for (const child of await listDirectory(entry as FileSystemDirectoryEntry))
    await walk(child, into, budget);
}

/** What was dropped: a single .zip, or a folder (its name stays in the paths, like a folder picker's). */
export async function readDrop(
  data: DataTransfer,
): Promise<{ entries: RawEntry[]; label: string; fallback: string | undefined }> {
  const first = data.files[0];
  if (data.files.length === 1 && first !== undefined && /\.zip$/i.test(first.name))
    return {
      entries: await readZipFile(first),
      label: `zip ${first.name}`,
      fallback: zipBaseName(first.name),
    };
  const entries: RawEntry[] = [];
  const budget = { left: SKILL_LIMITS.bytes * 4 };
  for (const item of Array.from(data.items)) {
    const entry = item.webkitGetAsEntry();
    if (entry !== null) await walk(entry, entries, budget);
  }
  if (entries.length === 0) throw new Error("drop a folder or a .zip");
  return { entries, label: `folder (${String(entries.length)} files)`, fallback: undefined };
}
