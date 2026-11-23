import { randomBytes } from "node:crypto";

/**
 * The viewer-to-desktop half of the public live view's pipe (ADR 0066). The viewer is anonymous and the desktop Pod
 * untrusted, so "view only" must not rest on x11vnc's `-viewonly` alone: this filter parses the WebSocket frames the
 * viewer sends and the RFB client messages inside them, and forwards only what a passive viewer needs. Key and pointer
 * events and clipboard text are dropped; anything it does not understand ends the connection. The other direction (the
 * framebuffer) is relayed raw and never parsed.
 */

/** The most one client frame may carry. A viewer sends a few bytes per message; more is not a viewer. */
const MAX_FRAME_PAYLOAD = 1024 * 1024;

/** The most of one ClientCutText that is skipped; more is not a viewer. */
const MAX_DROPPED_CUT_TEXT = 16 * 1024 * 1024;

/** The extended clipboard pseudo-encoding (-0x3F5E1A32): offering it would make the server answer in a format that carries clipboard data. */
const EXTENDED_CLIPBOARD = 0xc0a1e5ce;

/** A SetEncodings message without the extended clipboard pseudo-encoding, so the server never starts that exchange. */
function withoutExtendedClipboard(head: Buffer, list: Buffer): Buffer {
  const kept: Buffer[] = [];
  for (let at = 0; at + 4 <= list.length; at += 4) {
    if (list.readUInt32BE(at) !== EXTENDED_CLIPBOARD) kept.push(list.subarray(at, at + 4));
  }
  const header = Buffer.from(head);
  header.writeUInt16BE(kept.length, 2);
  return Buffer.concat([header, ...kept]);
}

const OP_CONTINUATION = 0x0;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** A masked client-to-server WebSocket frame (RFC 6455, 5.2); we are the client of the Pod, so we must mask. */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127, 0, 0, 0, 0]), uint32(length)]);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([header, mask, masked]);
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

export interface FilterResult {
  /** Bytes for the Pod, already framed and masked. */
  out: Buffer;
  /** The connection must end now (after `out` is written). */
  close: boolean;
}

type Phase = "version" | "security" | "init" | "messages";

/** One viewer's filter. Feed it the bytes the viewer sent, in order, in chunks of any size. */
export class ClientFilter {
  #wire = Buffer.alloc(0);
  #closed = false;
  /** A fragmented data message is open: the next data frame must be a continuation. */
  #fragmented = false;

  #phase: Phase = "version";
  #head = Buffer.alloc(0);
  /** Bytes of the current RFB message still to come, and whether they are forwarded. */
  #skip = 0;
  #pass = false;

  push(chunk: Buffer): FilterResult {
    if (this.#closed) return { out: Buffer.alloc(0), close: true };
    this.#wire = Buffer.concat([this.#wire, chunk]);
    const out: Buffer[] = [];
    while (!this.#done()) {
      const frame = this.#nextFrame();
      if (frame === undefined) break;
      this.#handleFrame(frame.opcode, frame.fin, frame.payload, out);
    }
    return { out: Buffer.concat(out), close: this.#closed };
  }

  #nextFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const wire = this.#wire;
    if (wire.length < 2) return undefined;
    const first = wire[0] ?? 0;
    const second = wire[1] ?? 0;
    // RSV bits mean an extension nobody negotiated; an unmasked frame is not from a browser.
    if ((first & 0x70) !== 0 || (second & 0x80) === 0) {
      this.#refuse();
      return undefined;
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (wire.length < 4) return undefined;
      length = wire.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (wire.length < 10) return undefined;
      if (wire.readUInt32BE(2) !== 0) {
        this.#refuse();
        return undefined;
      }
      length = wire.readUInt32BE(6);
      offset = 10;
    }
    if (length > MAX_FRAME_PAYLOAD) {
      this.#refuse();
      return undefined;
    }
    if (wire.length < offset + 4 + length) return undefined;
    const mask = wire.subarray(offset, offset + 4);
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) {
      payload[i] = (wire[offset + 4 + i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
    this.#wire = wire.subarray(offset + 4 + length);
    return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload };
  }

  #handleFrame(opcode: number, fin: boolean, payload: Buffer, out: Buffer[]): void {
    if (opcode === OP_PING || opcode === OP_PONG || opcode === OP_CLOSE) {
      if (!fin || payload.length > 125) {
        this.#closed = true;
        return;
      }
      out.push(encodeClientFrame(opcode, payload));
      return;
    }
    // Text frames carry no RFB; reserved opcodes are unknown. Both end the connection.
    if (opcode !== OP_BINARY && opcode !== OP_CONTINUATION) {
      this.#closed = true;
      return;
    }
    if ((opcode === OP_CONTINUATION) !== this.#fragmented) {
      this.#closed = true;
      return;
    }
    this.#fragmented = !fin;
    const forwarded = this.#rfb(payload);
    if (forwarded.length > 0) out.push(encodeClientFrame(OP_BINARY, forwarded));
  }

  #refuse(): void {
    this.#closed = true;
  }

  /** `#closed` through a call, because a check at the top of `push` would otherwise narrow it for the whole method. */
  #done(): boolean {
    return this.#closed;
  }

  /** Accumulates into `#head` until it holds `size` bytes; returns them then, else undefined. */
  #take(data: Buffer, at: number, size: number): { bytes: Buffer; used: number } | undefined {
    const need = size - this.#head.length;
    const part = data.subarray(at, at + need);
    this.#head = Buffer.concat([this.#head, part]);
    if (this.#head.length < size) return undefined;
    const bytes = this.#head;
    this.#head = Buffer.alloc(0);
    return { bytes, used: part.length };
  }

  /** The RFB bytes of the reassembled stream a passive viewer may send. */
  #rfb(data: Buffer): Buffer {
    const out: Buffer[] = [];
    let at = 0;
    while (at < data.length && !this.#done()) {
      if (this.#skip > 0) {
        const part = data.subarray(at, at + this.#skip);
        if (this.#pass) out.push(part);
        if (this.#encodings !== undefined) this.#encodings.parts.push(part);
        this.#skip -= part.length;
        at += part.length;
        if (this.#skip === 0 && this.#encodings !== undefined) {
          out.push(
            withoutExtendedClipboard(this.#encodings.head, Buffer.concat(this.#encodings.parts)),
          );
          this.#encodings = undefined;
        }
        continue;
      }
      switch (this.#phase) {
        case "version": {
          const taken = this.#take(data, at, 12);
          at += taken?.used ?? data.length - at;
          if (taken === undefined) break;
          // Only 3.7 and 3.8 name the security type in a client byte, which is what pins it to None.
          const text = taken.bytes.toString("latin1");
          if (text !== "RFB 003.008\n" && text !== "RFB 003.007\n") {
            this.#closed = true;
            break;
          }
          out.push(taken.bytes);
          this.#phase = "security";
          break;
        }
        case "security": {
          const byte = data[at];
          at += 1;
          // 1 is None. Any type that needs the client to answer further (VNC auth, ...) is refused here.
          if (byte !== 1) {
            this.#closed = true;
            break;
          }
          out.push(Buffer.from([1]));
          this.#phase = "init";
          break;
        }
        case "init": {
          at += 1;
          // Shared: this viewer must not disconnect the desktop's other clients.
          out.push(Buffer.from([1]));
          this.#phase = "messages";
          break;
        }
        case "messages": {
          at += this.#message(data, at, out);
          break;
        }
      }
    }
    return Buffer.concat(out);
  }

  /** Reads the start of one client message; returns the bytes it consumed. */
  #message(data: Buffer, at: number, out: Buffer[]): number {
    if (this.#head.length === 0) {
      const type = data[at] ?? -1;
      // Known types and the bytes of their fixed part (type included).
      const fixed: Readonly<Record<number, number>> = { 0: 20, 2: 4, 3: 10, 4: 8, 5: 6, 6: 8 };
      const size = fixed[type];
      if (size === undefined) {
        this.#closed = true;
        return 1;
      }
      this.#head = Buffer.from([type]);
      this.#headSize = size;
      return 1 + this.#finishHead(data, at + 1, out);
    }
    return this.#finishHead(data, at, out);
  }

  #headSize = 0;
  /** A SetEncodings whose list is still arriving; it is forwarded whole once the pseudo-encoding is removed. */
  #encodings: { head: Buffer; parts: Buffer[] } | undefined;

  /** Completes the fixed part of the message in `#head`, then decides what happens to the rest of it. */
  #finishHead(data: Buffer, at: number, out: Buffer[]): number {
    const need = this.#headSize - this.#head.length;
    const part = data.subarray(at, at + need);
    this.#head = Buffer.concat([this.#head, part]);
    if (this.#head.length < this.#headSize) return part.length;
    const head = this.#head;
    this.#head = Buffer.alloc(0);
    switch (head[0]) {
      case 0: // SetPixelFormat
      case 3: // FramebufferUpdateRequest
        out.push(head);
        break;
      case 2: // SetEncodings: 4 bytes per encoding follow
        if (head.readUInt16BE(2) === 0) {
          out.push(head);
          break;
        }
        this.#encodings = { head, parts: [] };
        this.#skip = head.readUInt16BE(2) * 4;
        this.#pass = false;
        break;
      case 6: {
        // ClientCutText: dropped with its text. The length is signed: a negative one is the extended clipboard format,
        // whose payload is |length| bytes. A viewer sends neither, so a size no viewer needs ends the connection.
        const size = Math.abs(head.readInt32BE(4));
        if (size > MAX_DROPPED_CUT_TEXT) this.#closed = true;
        this.#skip = size;
        this.#pass = false;
        break;
      }
      default: // KeyEvent, PointerEvent: dropped
        break;
    }
    return part.length;
  }
}
