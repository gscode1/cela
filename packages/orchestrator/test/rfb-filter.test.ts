import { describe, expect, it } from "vitest";
import { ClientFilter, encodeClientFrame } from "../src/rfb-filter.ts";

// The viewer-to-desktop filter of the public live view (ADR 0066): view-only must hold whatever the Pod's VNC server does.

const MASK = Buffer.from([0x12, 0x34, 0x56, 0x78]);

/** A masked client frame with an explicit FIN bit and opcode, for fragmentation and malformed-input cases. */
function frame(fin: boolean, opcode: number, payload: Buffer, masked = true): Buffer {
  const header = Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | payload.length]);
  if (!masked) return Buffer.concat([header, payload]);
  const body = Buffer.from(payload.map((byte, i) => byte ^ (MASK[i % 4] ?? 0)));
  return Buffer.concat([header, MASK, body]);
}

interface Decoded {
  opcode: number;
  payload: Buffer;
}

/** Reads the masked frames the filter produced, as the Pod would. */
function decode(wire: Buffer): Decoded[] {
  const out: Decoded[] = [];
  let at = 0;
  while (at < wire.length) {
    const opcode = (wire[at] ?? 0) & 0x0f;
    expect((wire[at + 1] ?? 0) & 0x80).toBe(0x80);
    let length = (wire[at + 1] ?? 0) & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = wire.readUInt16BE(offset);
      offset += 2;
    }
    const mask = wire.subarray(offset, offset + 4);
    const payload = Buffer.from(
      wire.subarray(offset + 4, offset + 4 + length).map((byte, i) => byte ^ (mask[i % 4] ?? 0)),
    );
    out.push({ opcode, payload });
    at = offset + 4 + length;
  }
  return out;
}

const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const handshake = Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([0])]);
const fbRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0x03, 0x20, 0x02, 0x58]);
const setPixelFormat = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 7)]);
const setEncodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0x11]);
const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 5]), Buffer.from("hello")]);

/** What the Pod receives, concatenated: the payload of every binary frame the filter emitted. */
function forwarded(filter: ClientFilter, chunks: Buffer[]): { bytes: Buffer; closed: boolean } {
  const parts: Buffer[] = [];
  let closed = false;
  for (const chunk of chunks) {
    const result = filter.push(chunk);
    for (const f of decode(result.out)) if (f.opcode === 2) parts.push(f.payload);
    closed ||= result.close;
  }
  return { bytes: Buffer.concat(parts), closed };
}

const allowed = Buffer.concat([fbRequest, setPixelFormat, setEncodings, fbRequest]);
const session = Buffer.concat([
  handshake,
  fbRequest,
  keyEvent,
  setPixelFormat,
  pointerEvent,
  cutText,
  setEncodings,
  keyEvent,
  pointerEvent,
  fbRequest,
]);
const expected = Buffer.concat([VERSION, Buffer.from([1, 1]), allowed]);

describe("ClientFilter", () => {
  it("lets the handshake through and forces the shared flag", () => {
    const { bytes, closed } = forwarded(new ClientFilter(), [frame(true, 2, handshake)]);
    expect(closed).toBe(false);
    expect(bytes).toEqual(Buffer.concat([VERSION, Buffer.from([1, 1])]));
  });

  it("drops key, pointer and cut-text messages and keeps the rest, in one frame", () => {
    const { bytes, closed } = forwarded(new ClientFilter(), [frame(true, 2, session)]);
    expect(closed).toBe(false);
    expect(bytes).toEqual(expected);
  });

  it("does the same with the RFB stream cut into frames of every size", () => {
    for (let size = 1; size <= 9; size += 1) {
      const frames: Buffer[] = [];
      for (let at = 0; at < session.length; at += size) {
        frames.push(frame(true, 2, session.subarray(at, at + size)));
      }
      const { bytes, closed } = forwarded(new ClientFilter(), frames);
      expect(closed, `frame size ${String(size)}`).toBe(false);
      expect(bytes, `frame size ${String(size)}`).toEqual(expected);
    }
  });

  it("does the same with the WebSocket bytes arriving one at a time", () => {
    const wire = frame(true, 2, session);
    const chunks = [...wire].map((byte) => Buffer.from([byte]));
    const { bytes, closed } = forwarded(new ClientFilter(), chunks);
    expect(closed).toBe(false);
    expect(bytes).toEqual(expected);
  });

  it("reassembles a message fragmented over WebSocket frames, with a ping in between", () => {
    const filter = new ClientFilter();
    const half = Math.floor(session.length / 2);
    const first = filter.push(frame(false, 2, session.subarray(0, half)));
    const ping = filter.push(frame(true, 9, Buffer.from("hi")));
    const rest = filter.push(frame(true, 0, session.subarray(half)));
    const frames = [...decode(first.out), ...decode(ping.out), ...decode(rest.out)];
    expect(frames.find((f) => f.opcode === 9)?.payload).toEqual(Buffer.from("hi"));
    expect(Buffer.concat(frames.filter((f) => f.opcode === 2).map((f) => f.payload))).toEqual(
      expected,
    );
    expect(first.close || ping.close || rest.close).toBe(false);
  });

  it("passes close and pong frames through", () => {
    const filter = new ClientFilter();
    const pong = decode(filter.push(frame(true, 10, Buffer.from("p"))).out);
    expect(pong).toEqual([{ opcode: 10, payload: Buffer.from("p") }]);
    const close = decode(filter.push(frame(true, 8, Buffer.from([0x03, 0xe8]))).out);
    expect(close).toEqual([{ opcode: 8, payload: Buffer.from([0x03, 0xe8]) }]);
  });

  it("closes on an unknown RFB message type, after forwarding what came before", () => {
    const { bytes, closed } = forwarded(new ClientFilter(), [
      frame(true, 2, Buffer.concat([handshake, fbRequest, Buffer.from([0x7f, 1, 2, 3])])),
    ]);
    expect(closed).toBe(true);
    expect(bytes).toEqual(Buffer.concat([VERSION, Buffer.from([1, 1]), fbRequest]));
  });

  it("closes when a message type that carries data for the desktop is not one of the five", () => {
    for (const type of [1, 7, 8, 128, 255]) {
      const { closed } = forwarded(new ClientFilter(), [
        frame(true, 2, Buffer.concat([handshake, Buffer.from([type])])),
      ]);
      expect(closed, `type ${String(type)}`).toBe(true);
    }
  });

  it("closes on a security type other than None, and on other protocol versions", () => {
    expect(
      forwarded(new ClientFilter(), [frame(true, 2, Buffer.concat([VERSION, Buffer.from([2])]))])
        .closed,
    ).toBe(true);
    for (const version of ["RFB 003.003\n", "RFB 003.889\n", "GET / HTTP/1."]) {
      const { bytes, closed } = forwarded(new ClientFilter(), [
        frame(true, 2, Buffer.from(version, "latin1")),
      ]);
      expect(closed, version).toBe(true);
      expect(bytes).toEqual(Buffer.alloc(0));
    }
  });

  it("closes on unmasked, text, reserved-bit and orphan continuation frames", () => {
    const bad = [
      frame(true, 2, VERSION, false),
      frame(true, 1, VERSION),
      frame(true, 0, VERSION),
      Buffer.from([0xc2, 0x80, 0, 0, 0, 0]),
      frame(false, 9, Buffer.from("x")),
    ];
    for (const wire of bad) expect(new ClientFilter().push(wire).close).toBe(true);
  });

  it("closes on a new data frame while a fragmented message is open", () => {
    const filter = new ClientFilter();
    expect(filter.push(frame(false, 2, VERSION.subarray(0, 4))).close).toBe(false);
    expect(filter.push(frame(true, 2, VERSION.subarray(4))).close).toBe(true);
  });

  it("closes on a frame larger than a viewer would send, and stays closed", () => {
    const filter = new ClientFilter();
    const huge = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0, ...MASK]);
    expect(filter.push(huge).close).toBe(true);
    expect(filter.push(frame(true, 2, VERSION)).out).toEqual(Buffer.alloc(0));
    expect(filter.push(frame(true, 2, VERSION)).close).toBe(true);
  });

  it("drops a long cut-text without holding it", () => {
    const text = Buffer.alloc(60_000, 65);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(text.length);
    const message = Buffer.concat([Buffer.from([6, 0, 0, 0]), len, text]);
    const { bytes, closed } = forwarded(new ClientFilter(), [
      encodeClientFrame(2, Buffer.concat([handshake, message, fbRequest])),
    ]);
    expect(closed).toBe(false);
    expect(bytes).toEqual(Buffer.concat([VERSION, Buffer.from([1, 1]), fbRequest]));
  });

  it("skips an extended-clipboard ClientCutText, whose length is negative, with its payload", () => {
    const payload = Buffer.alloc(40, 0x55);
    const len = Buffer.alloc(4);
    len.writeInt32BE(-payload.length);
    const message = Buffer.concat([Buffer.from([6, 0, 0, 0]), len, payload]);
    for (const size of [1, 7, 1000]) {
      const wire = Buffer.concat([handshake, message, fbRequest]);
      const frames: Buffer[] = [];
      for (let at = 0; at < wire.length; at += size) {
        frames.push(frame(true, 2, wire.subarray(at, at + size)));
      }
      const { bytes, closed } = forwarded(new ClientFilter(), frames);
      expect(closed, `frame size ${String(size)}`).toBe(false);
      expect(bytes, `frame size ${String(size)}`).toEqual(
        Buffer.concat([VERSION, Buffer.from([1, 1]), fbRequest]),
      );
    }
  });

  it("closes on a cut-text bigger than a viewer would ever skip, either sign", () => {
    for (const length of [0x7fffffff, -0x7fffffff, -0x80000000]) {
      const len = Buffer.alloc(4);
      len.writeInt32BE(length);
      const { closed } = forwarded(new ClientFilter(), [
        frame(true, 2, Buffer.concat([handshake, Buffer.from([6, 0, 0, 0]), len])),
      ]);
      expect(closed, String(length)).toBe(true);
    }
  });

  it("removes the extended clipboard pseudo-encoding from SetEncodings and fixes the count", () => {
    const list = [0, 1, 0xc0a1e5ce, 0xffffff11, 0xc0a1e5ce].map((value) => {
      const out = Buffer.alloc(4);
      out.writeUInt32BE(value);
      return out;
    });
    const head = Buffer.from([2, 0, 0, list.length]);
    const wire = Buffer.concat([handshake, head, ...list, fbRequest]);
    const want = Buffer.concat([
      VERSION,
      Buffer.from([1, 1]),
      Buffer.from([2, 0, 0, 3]),
      list[0] ?? Buffer.alloc(0),
      list[1] ?? Buffer.alloc(0),
      list[3] ?? Buffer.alloc(0),
      fbRequest,
    ]);
    for (const size of [1, 3, 5, 1000]) {
      const frames: Buffer[] = [];
      for (let at = 0; at < wire.length; at += size) {
        frames.push(frame(true, 2, wire.subarray(at, at + size)));
      }
      const { bytes, closed } = forwarded(new ClientFilter(), frames);
      expect(closed).toBe(false);
      expect(bytes, `frame size ${String(size)}`).toEqual(want);
    }
  });

  it("frames its output with a fresh mask each time (the Pod's server requires masked client frames)", () => {
    const first = encodeClientFrame(2, Buffer.from("abcd"));
    const second = encodeClientFrame(2, Buffer.from("abcd"));
    expect((first[1] ?? 0) & 0x80).toBe(0x80);
    expect(decode(first)[0]?.payload).toEqual(Buffer.from("abcd"));
    expect(first.subarray(2, 6).equals(second.subarray(2, 6))).toBe(false);
  });
});
