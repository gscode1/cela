import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Egress bindings (docs/decisions/0037-egress-onecli-route.md): the OneCLI agent token of one session, sealed for the
 * egress proxy. The orchestrator is the only writer; the proxy reads the table over its own role and opens a token only
 * when a `route=onecli` tunnel of that session needs it. The key lives in a Secret both processes mount, never in the
 * database, and the sandbox holds neither the key nor the token.
 */

type Db = Pick<pg.Pool, "query">;

export const BINDING_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD_PREFIX = "egress-binding:v1:";

/** The key as the Secret holds it: base64 (any alphabet, padded or not) of 32 bytes. The error never quotes the text. */
export function parseBindingKey(text: string): Buffer {
  const trimmed = text.trim();
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
  if (key?.length !== BINDING_KEY_BYTES) {
    throw new Error("the egress binding key must be 32 bytes, base64 encoded");
  }
  return key;
}

/** A fingerprint of the key that does not reveal it (the proxy computes the same). */
export function bindingKeyId(key: Buffer): string {
  return createHash("sha256")
    .update("egress-binding-key-id:")
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

export interface SealedBinding {
  keyId: string;
  nonce: Buffer;
  /** The encryption of the token followed by the 16-byte GCM tag. */
  ciphertext: Buffer;
}

function aad(sessionId: string): Buffer {
  return Buffer.from(AAD_PREFIX + sessionId.toLowerCase());
}

/** AES-256-GCM with a fresh random nonce; the session id is authenticated, so the row opens for that session only. */
export function sealBinding(key: Buffer, sessionId: string, token: string): SealedBinding {
  if (key.length !== BINDING_KEY_BYTES) throw new Error("the egress binding key must be 32 bytes");
  if (token === "") throw new Error("a binding needs a token");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(sessionId));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    keyId: bindingKeyId(key),
    nonce,
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
  };
}

/** The token of a sealed binding; throws when the key, the session or the bytes are not the ones it was sealed with. */
export function openBinding(key: Buffer, sessionId: string, sealed: SealedBinding): string {
  if (sealed.ciphertext.length <= TAG_BYTES) throw new Error("binding cannot be opened");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(sessionId));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("binding cannot be opened");
  }
}

/**
 * Stores (or replaces) the session's binding. The caller decides when: a repeat with the same token is cheap to skip,
 * and each write notifies the proxy.
 */
export async function putBinding(
  db: Db,
  key: Buffer,
  sessionId: string,
  token: string,
): Promise<void> {
  const sealed = sealBinding(key, sessionId, token);
  await db.query(
    `insert into egress.bindings (session_id, key_id, nonce, ciphertext) values ($1, $2, $3, $4)
     on conflict (session_id) do update set key_id = excluded.key_id, nonce = excluded.nonce,
       ciphertext = excluded.ciphertext, updated_at = clock_timestamp()`,
    [sessionId, sealed.keyId, sealed.nonce, sealed.ciphertext],
  );
}

/** Removes the session's binding; the proxy then denies its onecli route. Idempotent. True when there was one. */
export async function deleteBinding(db: Db, sessionId: string): Promise<boolean> {
  const { rowCount } = await db.query("delete from egress.bindings where session_id = $1", [
    sessionId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Session ids that have a binding (the sweep removes those whose session is gone). */
export async function boundSessions(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ session_id: string }>(
    "select session_id from egress.bindings order by session_id",
  );
  return rows.map((row) => row.session_id);
}

export async function hasBinding(db: Db, sessionId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from egress.bindings where session_id = $1", [
    sessionId,
  ]);
  return rows.length > 0;
}

export interface BindingCounts {
  total: number;
}

export async function bindingCounts(db: Db): Promise<BindingCounts> {
  const { rows } = await db.query<{ total: string }>(
    "select count(*) as total from egress.bindings",
  );
  return { total: Number(rows[0]?.total ?? 0) };
}
