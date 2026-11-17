import { inflateRawSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildZip } from "../src/index.ts";

interface Parsed {
  path: string;
  content: Buffer;
  mode: number;
  unix: boolean;
}

/** An independent reader: end record, central directory, then each local entry, checking sizes and CRC-32. */
function readZip(zip: Buffer): Parsed[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Parsed[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const made = zip.readUInt16LE(at + 4);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const attributes = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const content = method === 0 ? raw : inflateRawSync(raw);
    expect(crc32(content)).toBe(crc);
    out.push({ path, content, mode: attributes >>> 16, unix: made >> 8 === 3 });
    at += 46 + nameLength;
  }
  return out;
}

describe("buildZip", () => {
  it("round-trips paths, bytes and the executable bit", () => {
    const binary = Buffer.from([0, 1, 2, 255, 254]);
    const zip = buildZip([
      { path: "SKILL.md", content: Buffer.from("---\ndescription: d\n---\n"), executable: false },
      { path: "scripts/run.sh", content: Buffer.from("echo hi\n"), executable: true },
      { path: "data/blob.bin", content: binary, executable: false },
      { path: "empty", content: new Uint8Array(0), executable: false },
    ]);
    const files = readZip(zip);
    expect(files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "scripts/run.sh",
      "data/blob.bin",
      "empty",
    ]);
    expect(files.map((f) => f.mode.toString(8))).toEqual(["100644", "100755", "100644", "100644"]);
    expect(files.every((f) => f.unix)).toBe(true);
    expect(files[1]?.content.toString()).toBe("echo hi\n");
    expect(files[2]?.content.equals(binary)).toBe(true);
  });

  it("is deterministic and valid when empty", () => {
    const entries = [{ path: "a", content: Buffer.from("x"), executable: false }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
    expect(readZip(buildZip([]))).toEqual([]);
  });
});
