import { crc32 } from "node:zlib";

/** A file for `buildZip`: a `/`-separated relative path, its bytes and the Unix executable bit. */
export interface ZipEntry {
  path: string;
  content: Uint8Array;
  executable: boolean;
}

/** 1980-01-01 00:00:00, so the same files always give the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;
/** "Version made by": Unix (3) and ZIP spec 2.0, so extractors read the mode in the external attributes. */
const MADE_BY = (3 << 8) | 20;
const NEEDED = 20;
/** General purpose bit 11: names are UTF-8. */
const UTF8 = 0x0800;
const MODE_FILE = 0o100644;
const MODE_EXECUTABLE = 0o100755;

/**
 * A ZIP archive of the entries, stored without compression (a skill is at most 5 MiB, so compressing saves little and
 * a writer stays tiny), in the order given. Each file keeps its path and its mode (0644 or 0755) in the Unix external
 * attributes, which is how `unzip` restores the executable bit. No ZIP64: the callers' limits (128 files, 5 MiB) fit
 * the classic format, and anything beyond it throws.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("too many files for a zip");
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.content);
    if (name.length > 0xffff || data.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error("zip entry too large");
    }
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(NEEDED, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(MADE_BY, 4);
    header.writeUInt16LE(NEEDED, 6);
    header.writeUInt16LE(UTF8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.executable ? MODE_EXECUTABLE : MODE_FILE) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
