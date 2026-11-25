import { z } from "zod";
import {
  destructiveAnnotations,
  MAX_REVISION,
  readAnnotations,
  registerGet,
  registerList,
  skillName,
  untrusted,
  writeAnnotations,
  type AdminContext,
} from "./context.js";

/**
 * The most a publish may send: ingest's body limit for a skill version (session-core `SKILL_BODY_LIMIT`: the 5 MiB of
 * file bytes as base64 plus 256 KiB of JSON; a test keeps the two equal, because the adapter does not depend on
 * session-core at run time). A larger body is refused here instead of being sent to be refused there.
 */
export const SKILL_BODY_LIMIT = Math.ceil((5 * 1024 * 1024 * 4) / 3) + 256 * 1024;
/** Most files in a version (session-core `SKILL_LIMITS.files`). */
const MAX_FILES = 128;
/** Most file bytes `admin_get_skill_version` returns in one answer, so a big skill does not fill the context. */
export const CONTENT_CAP = 200 * 1024;
/** A publish may take a while: ingest hashes and stores up to 5 MiB. */
const PUBLISH_TIMEOUT_MS = 120_000;

const fileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(200)
      .describe("Relative path inside the skill, for example SKILL.md or scripts/run.sh."),
    content: z.string().optional().describe("UTF-8 text of the file."),
    contentBase64: z.string().optional().describe("Base64 bytes, for a binary file."),
    executable: z.boolean().optional().describe("Mark the file executable (default false)."),
  })
  .refine((file) => (file.content === undefined) !== (file.contentBase64 === undefined), {
    message: "give exactly one of content and contentBase64",
  });

/** UTF-8 text without NUL, or undefined when the bytes are binary. The BOM is kept so a re-upload gives the same digest. */
function decodeText(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Skills (`/admin/skills`): reads, the writes tier's publish and the dangerous tier's delete (ADR 0070). */
export function registerSkillTools(ctx: AdminContext): void {
  registerList(ctx, "skills", "skills", "List skills with their current version and description.");
  registerGet(
    ctx,
    "skill",
    "skills",
    skillName,
    "Get a skill with every version's description and file manifest.",
  );
  ctx.server.registerTool(
    "admin_get_skill_version",
    {
      description: `Get one skill version: its manifest (path, size, sha256, executable) and, with content true, the files, so a skill can be reviewed like code. Text files come as content, binary ones as contentBase64. At most about ${String(CONTENT_CAP / 1024)} KB of file content is returned: further files are listed without content and truncated is true, so ask for them with paths. ${untrusted}`,
      inputSchema: z.object({
        name: skillName,
        version: z.number().int().min(1).max(MAX_REVISION).describe("The version number."),
        content: z.boolean().optional().describe("Also return the file contents (default false)."),
        paths: z
          .array(z.string().max(200))
          .max(MAX_FILES)
          .optional()
          .describe("Only these files, by path. Absent: all."),
      }),
      annotations: readAnnotations,
    },
    async (args, extra) => {
      const suffix = args.content === true ? "?content=true" : "";
      const result = await ctx.call(
        "GET",
        `/admin/skills/${encodeURIComponent(args.name)}/versions/${String(args.version)}${suffix}`,
        extra.mcpReq.signal,
      );
      const version = result.structuredContent;
      const list = version.files;
      if (result.isError === true || !Array.isArray(list)) return result;
      const wanted = args.paths === undefined ? undefined : new Set(args.paths);
      let budget = CONTENT_CAP;
      const cut = { truncated: false };
      const files = list
        .filter(
          (file: unknown) =>
            wanted === undefined ||
            (typeof file === "object" &&
              file !== null &&
              "path" in file &&
              typeof file.path === "string" &&
              wanted.has(file.path)),
        )
        .map((file: unknown) => {
          if (typeof file !== "object" || file === null) return file;
          const { contentBase64, ...rest } = file as Record<string, unknown>;
          if (typeof contentBase64 !== "string") return rest;
          const bytes = Buffer.from(contentBase64, "base64");
          if (bytes.length > budget) {
            cut.truncated = true;
            return rest;
          }
          budget -= bytes.length;
          const text = decodeText(bytes);
          // Decoded text is scrubbed here: `call` only saw it as base64.
          return text === undefined
            ? { ...rest, contentBase64 }
            : { ...rest, content: ctx.scrub(text) };
        });
      return ctx.reply({ ...version, files, ...(cut.truncated ? { truncated: true } : {}) });
    },
  );
  if (ctx.tiers.writes) {
    ctx.server.registerTool(
      "admin_publish_skill",
      {
        description: `Publish a skill version from inline files (never from a local path, so large or binary skills go through the console or curl). files must include SKILL.md with a YAML frontmatter block giving the description (and a name equal to name, if present); at most ${String(MAX_FILES)} files, the whole body within ${String(Math.floor(SKILL_BODY_LIMIT / 1024 / 1024))} MiB. Identical content to the current version writes nothing (versionCreated false). Profiles pin an exact version, so a new version changes no profile. ${untrusted}`,
        inputSchema: z.object({
          name: skillName,
          files: z.array(fileSchema).min(1).max(MAX_FILES),
          source: z
            .object({
              repository: z.string().min(1).max(200),
              commit: z.string().regex(/^[0-9a-f]{7,64}$/),
            })
            .optional()
            .describe("Where the skill came from; stored, not part of the digest."),
        }),
        annotations: writeAnnotations,
      },
      async ({ name, ...body }, extra) => {
        if (Buffer.byteLength(JSON.stringify(body)) > SKILL_BODY_LIMIT)
          return ctx.reply(
            {
              error: `the skill is larger than ${String(SKILL_BODY_LIMIT)} bytes as JSON; not sent. Publish it through the console or curl.`,
              status: 413,
            },
            true,
          );
        return ctx.call(
          "POST",
          `/admin/skills/${encodeURIComponent(name)}/versions`,
          extra.mcpReq.signal,
          body,
          { timeoutMs: PUBLISH_TIMEOUT_MS },
        );
      },
    );
  }
  if (ctx.tiers.dangerous) {
    ctx.server.registerTool(
      "admin_delete_skill",
      {
        description: `Delete a skill with every version and file. expectedRevision is its current version (currentVersion of admin_get_skill). Refused with 409 and blockedBy while a profile's current version or a session that is not deleted pins it; the name cannot be created again. ${untrusted}`,
        inputSchema: z.object({
          name: skillName,
          expectedRevision: z
            .number()
            .int()
            .min(1)
            .max(MAX_REVISION)
            .describe("The skill's current version."),
        }),
        annotations: destructiveAnnotations,
      },
      async (args, extra) =>
        ctx.call(
          "DELETE",
          `/admin/skills/${encodeURIComponent(args.name)}?expectedRevision=${String(args.expectedRevision)}`,
          extra.mcpReq.signal,
        ),
    );
  }
}
