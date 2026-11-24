/* global process, fetch, console, AbortSignal */
// Moves the pinned Google Chrome of images/sandbox-desktop/Dockerfile (ARG CHROME_VERSION) to the version Google's apt
// repository serves now (docs/decisions/0065-desktop-sandbox.md, "Chrome is pinned"). Google keeps only the current build in
// its Packages index, so an old pin stops installing within weeks and the pin has to follow.
//
//   node hack/chrome-bump.mjs            fetch both Packages indexes, rewrite the Dockerfile default when newer
//   node hack/chrome-bump.mjs <amd64-Packages> <arm64-Packages>   read local files instead (tests, offline)
//
// Prints `current=<pin>`, `latest=<version>` and `bump=true|false` (also appended to $GITHUB_OUTPUT). Exit 1 when the two
// architectures list different versions: Google publishes them a little apart, and an image must have the same Chrome on both.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = join(root, "images/sandbox-desktop/Dockerfile");
const index = (arch) =>
  `https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-${arch}/Packages`;
const pinPattern = /^ARG CHROME_VERSION=(\S+)$/m;

/** The Version of the google-chrome-stable stanza of a Debian Packages index. */
export function chromeVersion(packages) {
  for (const stanza of packages.split(/\n\s*\n/)) {
    if (!/^Package: google-chrome-stable$/m.test(stanza)) continue;
    const m = /^Version: (\S+)$/m.exec(stanza);
    if (m) return m[1];
  }
  throw new Error("no google-chrome-stable stanza with a Version in the Packages index");
}

/** Orders Debian versions made of numeric parts (158.0.8127.88-1); other shapes are refused rather than guessed at. */
export function compareVersions(a, b) {
  const parts = (v) => {
    if (!/^\d+(\.\d+)*(-\d+)?$/.test(v)) throw new Error(`unsupported version format: ${v}`);
    return v.split(/[.-]/).map(Number);
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** What to do given the pin and the two indexes: `{ bump, latest }`, or a throw when the architectures disagree. */
export function decide(current, amd64Packages, arm64Packages) {
  const amd64 = chromeVersion(amd64Packages);
  const arm64 = chromeVersion(arm64Packages);
  if (amd64 !== arm64)
    throw new Error(
      `amd64 lists ${amd64} but arm64 lists ${arm64}: wait until Google publishes both`,
    );
  return { bump: compareVersions(amd64, current) > 0, latest: amd64 };
}

export function currentPin(dockerfileText) {
  const m = pinPattern.exec(dockerfileText);
  if (!m) throw new Error("images/sandbox-desktop/Dockerfile has no `ARG CHROME_VERSION=` line");
  return m[1];
}

export function withPin(dockerfileText, version) {
  return dockerfileText.replace(pinPattern, `ARG CHROME_VERSION=${version}`);
}

async function load(arch, file) {
  if (file) return readFileSync(file, "utf8");
  const res = await fetch(index(arch), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${index(arch)}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const [amd64File, arm64File] = process.argv.slice(2);
  const text = readFileSync(dockerfile, "utf8");
  const current = currentPin(text);
  const { bump, latest } = decide(
    current,
    await load("amd64", amd64File),
    await load("arm64", arm64File),
  );
  if (bump) writeFileSync(dockerfile, withPin(text, latest));
  const lines = `current=${current}\nlatest=${latest}\nbump=${bump}\n`;
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`chrome-bump: ${err.message}`);
    process.exit(1);
  });
}
