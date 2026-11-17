import { unzipSync } from "fflate";
import type { RawEntry } from "@/lib/skills/bundle";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const UNIX = 3;

interface CentralEntry {
  name: string;
  /** `undefined` when the zip was not made on Unix: it carries no mode. */
  mode: number | undefined;
  size: number;
}

/**
 * The central directory, read by hand because fflate does not expose the external attributes where the Unix mode
 * (and so the executable bit) lives. Zip64 and encrypted archives are refused.
 */
function centralDirectory(zip: Uint8Array): CentralEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file (no end of central directory)");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff)
    throw new Error("zip64 archives are not supported");
  const decoder = new TextDecoder("utf-8");
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== CENTRAL)
      throw new Error("the zip's central directory is damaged");
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    if ((flags & 1) !== 0) throw new Error("encrypted zip entries are not supported");
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const attributes = view.getUint32(offset + 38, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, mode: madeBy >> 8 === UNIX ? attributes >>> 16 : undefined, size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Unpacks a zip in the browser. The executable bit is the Unix mode's `0o111` (a zip from another host has none, so
 * `executable` is `undefined` and the review step lets the operator set it). A symlink or another irregular file is
 * reported on the entry, because only regular files can be published. `maxBytes` is checked against the declared sizes
 * before anything is inflated.
 */
export function unpackZip(zip: Uint8Array, maxBytes: number): RawEntry[] {
  const central = centralDirectory(zip).filter((entry) => !entry.name.endsWith("/"));
  const declared = central.reduce((sum, entry) => sum + entry.size, 0);
  if (declared > maxBytes)
    throw new Error(
      `the zip unpacks to ${String(declared)} bytes, over the ${String(maxBytes)} bytes limit`,
    );
  const files = unzipSync(zip, { filter: (file) => !file.name.endsWith("/") });
  return central.map((entry) => {
    const bytes = files[entry.name];
    if (bytes === undefined) throw new Error(`could not read "${entry.name}" from the zip`);
    const kind = entry.mode === undefined ? S_IFREG : entry.mode & S_IFMT;
    const raw: RawEntry = {
      path: entry.name,
      bytes,
      executable: entry.mode === undefined ? undefined : (entry.mode & 0o111) !== 0,
    };
    if (kind !== S_IFREG && kind !== 0)
      raw.irregular = kind === S_IFLNK ? "is a symbolic link" : "is not a regular file";
    return raw;
  });
}
