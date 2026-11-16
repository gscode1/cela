import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type pg from "pg";
import {
  buildSkillCatalog,
  isSkillDigest,
  readSkillBundle,
  readSkillVersion,
  skillDir,
  verifySkillBundle,
} from "@pi-durable-k8s/session-core";
import type { ProfileDefinition, SkillBundle, SkillRef } from "@pi-durable-k8s/session-core";
import type { WorkspaceEnv } from "./workspace.js";

/** Skills live under this directory of the workspace, as `<name>/<digest>/` (docs/decisions/0011-skills-in-postgres.md). */
export const SKILLS_DIR = "/workspace/.skills";
/** Staging for a bundle being written; renamed into place when complete, and cleared at each attach. */
const STAGING = ".staging";

/**
 * A skill the session's snapshot pins that Postgres cannot give back intact: missing, a different digest, or bytes that
 * do not match their hashes. Versions are immutable, so retrying cannot help: the caller fails closed.
 */
export class SkillIntegrityError extends Error {}

/** A pinned skill: the snapshot of a profile has the digest filled in by the admin write; anything else is refused. */
function pinned(ref: SkillRef): SkillRef & { digest: string } {
  if (!isSkillDigest(ref.digest)) {
    throw new SkillIntegrityError(
      `the profile snapshot does not pin a digest for skill ${ref.name} v${String(ref.version)}`,
    );
  }
  return { ...ref, digest: ref.digest };
}

/** Reads skill content from Postgres, always by exact (name, version) and checked against the pinned digest. */
export class SkillLibrary {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /**
   * The catalog text for a new conversation's instructions, or undefined for a profile without skills. Metadata only:
   * the bodies stay in Postgres until a sandbox needs them.
   */
  async catalogFor(definition: ProfileDefinition): Promise<string | undefined> {
    const refs = (definition.skills ?? []).map(pinned);
    if (refs.length === 0) return undefined;
    const entries: { name: string; description: string; digest: string }[] = [];
    for (const ref of refs) {
      const meta = await readSkillVersion(this.#pool, ref.name, ref.version);
      if (meta === undefined) {
        throw new SkillIntegrityError(`skill ${ref.name} v${String(ref.version)} does not exist`);
      }
      if (meta.digest !== ref.digest) {
        throw new SkillIntegrityError(
          `skill ${ref.name} v${String(ref.version)} has digest ${meta.digest}, the snapshot pinned ${ref.digest}`,
        );
      }
      entries.push({ name: ref.name, description: meta.description, digest: meta.digest });
    }
    return buildSkillCatalog(entries, SKILLS_DIR);
  }

  /** The verified bundles of a conversation's session (none for a session without skills or one the inbox does not know). */
  async bundlesFor(conversationId: number): Promise<SkillBundle[]> {
    const { rows } = await this.#pool.query<{ profile_snapshot: unknown }>(
      "select profile_snapshot from inbox.sessions where conversation_id = $1",
      [conversationId],
    );
    const snapshot = rows[0]?.profile_snapshot;
    const skills =
      typeof snapshot === "object" && snapshot !== null && "skills" in snapshot
        ? snapshot.skills
        : undefined;
    if (!Array.isArray(skills) || skills.length === 0) return [];
    const bundles: SkillBundle[] = [];
    for (const raw of skills as SkillRef[]) {
      const ref = pinned(raw);
      const bundle = await readSkillBundle(this.#pool, ref.name, ref.version);
      if (bundle === undefined) {
        throw new SkillIntegrityError(`skill ${ref.name} v${String(ref.version)} does not exist`);
      }
      const problem = verifySkillBundle(bundle, ref.digest);
      if (problem !== undefined) throw new SkillIntegrityError(problem);
      bundles.push(bundle);
    }
    return bundles;
  }
}

async function must<T>(
  result: Promise<{ ok: true; value: T } | { ok: false; error: Error }>,
  what: string,
): Promise<T> {
  const done = await result;
  if (!done.ok) throw new Error(`${what}: ${done.error.message}`);
  return done.value;
}

/**
 * Writes verified bundles to `<root>/<name>/<digest>/` of a sandbox. Idempotent and atomic: a bundle is written to a
 * staging directory and renamed into place, so a directory at its final path is complete, and a crash leaves only
 * staging, which the next call clears. A bundle whose directory exists is left alone (the digest in the path is its
 * content), so a repeat call writes nothing. Called once per env open, before the env serves its first operation.
 * Returns the bundles it wrote.
 */
export async function materializeSkills(
  env: WorkspaceEnv,
  bundles: readonly SkillBundle[],
  root: string = SKILLS_DIR,
): Promise<string[]> {
  if (bundles.length === 0) return [];
  const staging = `${root}/${STAGING}`;
  await must(env.remove(staging, { recursive: true, force: true }, context), "clear skill staging");
  const written: string[] = [];
  for (const bundle of bundles) {
    const problem = verifySkillBundle(bundle);
    if (problem !== undefined) throw new SkillIntegrityError(problem);
    const final = skillDir(bundle.name, bundle.digest, root);
    if (await must(env.exists(final, context), `check ${final}`)) continue;
    const stage = `${staging}/${bundle.name}-${bundle.digest}`;
    const dirs = new Set<string>([stage]);
    for (const file of bundle.files) {
      const slash = file.path.lastIndexOf("/");
      if (slash > 0) dirs.add(`${stage}/${file.path.slice(0, slash)}`);
    }
    for (const dir of [...dirs].sort()) {
      await must(env.createDir(dir, { recursive: true }, context), `create ${dir}`);
    }
    for (const file of bundle.files) {
      const bytes = bundle.contents.get(file.path);
      if (bytes === undefined) throw new SkillIntegrityError(`${file.path} is missing`);
      await must(env.writeFile(`${stage}/${file.path}`, bytes, context), `write ${file.path}`);
    }
    const executable = bundle.files.filter((file) => file.executable).map((file) => file.path);
    if (executable.length > 0) {
      const run = await must(
        env.exec(
          ["chmod", "755", ...executable.map((path) => `${stage}/${path}`)],
          {
            cwd: root,
            timeout: 30,
          },
          context,
        ),
        "chmod",
      );
      if (run.exitCode !== 0)
        throw new Error(`chmod of skill ${bundle.name} failed (exit ${String(run.exitCode)})`);
    }
    await must(
      env.createDir(`${root}/${bundle.name}`, { recursive: true }, context),
      `create ${root}/${bundle.name}`,
    );
    try {
      await must(env.renameFile(stage, final, context), `move ${bundle.name} into place`);
    } catch (error) {
      // Lost a race to another writer of the same bundle: complete by construction, so only a real failure throws.
      if (!(await must(env.exists(final, context), `check ${final}`))) throw error;
    }
    written.push(`${bundle.name}/${bundle.digest}`);
  }
  await must(env.remove(staging, { recursive: true, force: true }, context), "clear skill staging");
  return written;
}
