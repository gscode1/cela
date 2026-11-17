import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAllYaml } from "@kubernetes/client-node";

// Parsed YAML has no static shape; the tests that read it assert on every field they use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export const repoRoot = resolve(import.meta.dirname, "../../../..");
export const chartsDir = join(repoRoot, "charts");

export const chartNames = (): string[] => readdirSync(chartsDir).sort();

// Values a chart cannot default (image tags, the database Secret): charts/<chart>/ci/required-values.yaml, passed
// first so that a test's own --set wins. The file is not part of the packaged chart (.helmignore).
export const requiredValuesArgs = (chart: string): string[] => {
  const file = join(chartsDir, chart, "ci", "required-values.yaml");
  return existsSync(file) ? ["--values", file] : [];
};

// `helm template` of a chart in charts/. Helm must be installed (CI sets it up); a missing binary fails the test
// instead of skipping it.
export const helmTemplate = (chart: string, args: string[] = []): string =>
  execFileSync(
    "helm",
    [
      "template",
      "rel",
      join(chartsDir, chart),
      "--namespace",
      "ns",
      ...requiredValuesArgs(chart),
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

export const renderDocs = (chart: string, args: string[] = []): Obj[] =>
  (loadAllYaml(helmTemplate(chart, args)) as (Obj | null)[]).filter((d): d is Obj => d !== null);
