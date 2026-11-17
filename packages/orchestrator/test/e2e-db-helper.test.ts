import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("runs SQL through a restricted URI-secret client without knowing the server Pod or backend", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-db-helper-"));
  try {
    const script = `
      source "$1"
      # Capture commands independently of their positional arguments.
      k() {
        printf '%s\\n' "$*" >>"$TEST_DIR/calls"
        case "$1 $2" in
          'get pod') return 1 ;;
          'create -f') cat >"$TEST_DIR/pod.yaml" ;;
          *) return 0 ;;
        esac
      }
      e2e_db_start
      e2e_db -c "select 'quoted value'"
    `;
    const result = spawnSync(
      "bash",
      ["-euc", script, "sh", resolve(import.meta.dirname, "../../../tests/e2e/fns.sh")],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          TEST_DIR: dir,
          E2E_DB_SECRET: "external-database",
          E2E_DB_URI_KEY: "connection",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(join(dir, "pod.yaml"), "utf8");
    expect(manifest).toContain('secretKeyRef: {name: "external-database", key: "connection"}');
    expect(manifest).toContain("automountServiceAccountToken: false");
    expect(manifest).toContain("app.kubernetes.io/name: e2e-db-client");
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toContain('exec psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 "$@"');
    expect(calls).toContain("select 'quoted value'");
    expect(calls).not.toMatch(/pi-pg-1|cnpg|postgres -d app/);
    expect(result.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
