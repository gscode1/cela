# 0065: Desktop sandbox: a virtual X desktop with a few apps, driven through accessibility

Status: accepted, 2026-11-23 (issues #405 spike, #408). Builds on [0041](0041-browser-sandbox.md) (flavours; this is the
second one), [0064](0064-sandbox-runtimes.md) (named runtimes), [0038](0038-network-modes.md) (the egress proxy),
[0030](0030-sandbox-sizes.md) and [0019](0019-restricted-pod-security.md).

## Context

The browser flavour (ADR 0041) lets an agent read and drive web pages. Some tasks live in programs that have no page: a
text editor, a word processor, a native dialog, a site that wants a real Firefox. The agent needs a desktop it can see and
operate, in the same cage as every other session (gVisor, no credentials, filtered network). A spike (#405) measured what
that costs and which control path works.

## Decision

### A third flavour, `desktop`

`sandboxFlavour: desktop` selects the image `pi-sandbox-desktop` (`images/sandbox-desktop`): the sandboxd base, the `pi-env`
bridge, a virtual X server (Xvfb, 1280x800) with openbox, a session D-Bus and the AT-SPI bus, and three apps: mousepad,
LibreOffice Writer and Firefox ESR. It is behind `sandbox.flavours.desktop.enabled`, **off by default** (the image is large
and nobody asked for it until a profile does), and needs `images.sandboxDesktop` when on (the chart fails without a tag or
digest, like the other images). The flavour composes with sizes, network modes and named runtimes exactly like `browser`:

- Templates and pools: `pi-env[-rt-<runtime>][-desktop][-direct]-template|pool[-<size>]`, for example
  `pi-env-desktop-template-m`, `pi-env-desktop-direct-pool` and `pi-env-rt-gvisorkvm-desktop-pool-xl`. `warmPoolFor` gains
  the `desktop` case and stays one pure function. `desktop` joins the reserved runtime names.
- Label `cela.dev/sandbox-flavour: desktop` on templates, pools and pod templates, which the NetworkPolicies select on as
  for any flavour.
- Its own resources whatever the size (the size still sets the workspace): requests 1 CPU and 2Gi, limits 4 CPU and 6Gi,
  `ephemeralStorage: 4Gi` (the apps' profiles and caches live in `/tmp` and `$HOME`, outside `/workspace`) and a
  memory-backed `/dev/shm` of `shmSize: 256Mi` (Firefox, LibreOffice and Xvfb use it; it counts against the memory limit).
  `warmPoolReplicas` is 0, like every pool (ADR 0001): the pools exist because a claim must name one.
- Pod security is the restricted profile, as for every sandbox: non-root uid/gid 1000 (`pi`, with a passwd entry and
  `HOME=/home/pi`: the session bus refuses to start for a uid without one), no capabilities, no privilege escalation.

### No credentials, the same rules as the browser

An agent that opens documents and web pages is shown untrusted content. Nothing in its sandbox may be worth stealing, so a
desktop session gets no `repo`, no credentialed MCP server and no `onecli` route. The browser flavour already had this rule
(ADR 0041); it is now written once for the **untrusted-content flavours** (`browser` and `desktop`) in session-core
(`UNTRUSTED_CONTENT_FLAVOURS`, `untrustedFlavourConflict`), and every place that enforced it for the browser enforces it for
the desktop: profile writes, `POST /sessions` (re-checked, the catalog and rules may have changed), MCP catalog writes (a
credential is refused while a desktop profile names the server) and the orchestrator's MCP access (a desktop session is
granted nothing). The error text names the flavour (`sandboxFlavour desktop cannot be combined with ...`). The model's
credentials stay in the orchestrator, as always.

### Network

Firefox reaches the web only through the session's egress proxy, via the same loopback forwarder as the browser image
(`packages/browser-proxy`, 127.0.0.1:3129), and its enterprise policy sets the proxy for all protocols and disables
telemetry, updates, DNS over HTTPS, sync and the password manager. The seeded profile is `proxied` with the `open-web` rule
set, like `browser`. The `-direct` twins are rendered for the flavour when the gate `security.allowDirectSandboxEgress`
is on, as for the browser; direct mode keeps its own rules (no repo, no credentialed MCP, no `onecli` route).

### Control: accessibility first, xdotool and screenshots as the fallback

The agent drives the desktop with [agent-desktop](https://github.com/vercel-labs/agent-desktop) 1.3.1 (a pinned release binary), which reads the
AT-SPI accessibility tree and acts on elements by ref. Everything goes through `agent-desktop-run`, a lazy wrapper that
starts Xvfb, the buses and openbox on first use (276 ms to the first command on runc). `desktop-launch <mousepad|writer|
firefox>` starts an app with the right accessibility environment. Where a tree is not enough (LibreOffice's page body has no
ref, typing into Firefox's fields needs the headed mode), the agent uses `xdotool` for keys and text and `scrot` for a
screenshot, through `agent-desktop-run --exec`. Two skills ship with the image and are seeded by
`hack/seed-desktop-profile.mjs`: `agent-desktop` (the tool) and `desktop-sandbox` (what is in this sandbox and its limits).

### Measured (spike #405: arm64, agent-desktop 1.3.1, at-spi2-core 2.46)

- A tree of a text editor (mousepad) is about 270 refs, 47 kB and 11.9k tokens in full, 3.9k as a skeleton; Writer is 1587
  refs and 56k tokens in full (5k as a skeleton); Firefox 506 refs and 24k tokens. Agents should snapshot a skeleton or one
  window, then act, not snapshot after every step.
- Memory: the desktop idles at 110 MB; mousepad 97 MB, Writer 313 MB, Firefox 1.4 to 1.5 GB RSS (about 860 MB in the
  cgroup). The 6Gi limit leaves room for Firefox and Writer together.
- Launch to a usable tree on runc: mousepad 0.8 s, Firefox 4.2 s, Writer 5.7 s.
- Known tool problems: `press` crashes Electron and sometimes Chromium (neither is in the image); Writer's toolbar fields
  are ambiguous targets; headless `focus` is denied.

### Runtimes

The cost of a snapshot is about 4,075 synchronous D-Bus round trips, whatever the output size, so it scales with how dear a
syscall and a socket round trip are. Measured on the same node:

| runtime | mousepad snapshot | Firefox snapshot | Writer snapshot | launch to a tree (mousepad / Firefox) |
|---|---|---|---|---|
| runc | 0.1 s (laptop), 0.6 s (node) | 4 to 5.5 s | 3.7 s | 2.0 s / 17 s |
| gVisor | 3 s | 10 s, incomplete at the default timeout | never ready at 10 s, 13 to 15 s at a long timeout | 6.7 s / 19 s |

- **gVisor (the default runtime) works but is slow**: 4 to 30 times runc on the same node. The skills tell the agent to
  pass `--timeout-ms 60000` or more to snapshots and 30000 to `type`; the default deadlines, sized for runc, truncate trees
  and make clicks on stale refs ambiguous. Idle CPU is about 0 in both.
- **runc is fast and insecure** (the agent's code shares the node kernel). It needs the entry's own `allowInsecureRuntime`
  and, per ADR 0064, tainted nodes. It is the right choice only for a trusted use.
- **A KVM-backed gVisor (`gvisor-kvm`) is the candidate** for a desktop that is both isolated and responsive; it was not
  measured here. Define it as a named runtime that lists `desktop` and pick it with `sandboxRuntime` in the profile
  (`node hack/seed-desktop-profile.mjs --runtime gvisorkvm`).
- More CPU does not help gVisor (10 to 15% at best, inside noise): the chain is latency-bound.

### Firefox runs without its own sandbox

Firefox's content sandbox needs user namespaces, which the Pod does not have (all capabilities dropped), so the launcher
sets `MOZ_DISABLE_CONTENT_SANDBOX=1`, like Chromium's `--no-sandbox` in the browser image (ADR 0041). The runtime is the
boundary. Under gVisor that is a real boundary; under runc a renderer exploit runs as uid 1000 on the node's kernel with
only seccomp and dropped capabilities in the way. That is part of what `allowInsecureRuntime` acknowledges for a runc
desktop. Firefox shows a harmless "security sandbox is disabled" banner.

### Durability

The desktop and its apps live in the sandbox container. When the Pod is recycled (a node drain, a crash, a suspend and
resume that starts a new Pod) the desktop is gone: open windows, unsaved documents, the browser session. `/workspace` is
the volume and survives; the agent is told to save there. The wrapper restarts the desktop on the next call, so a lost
desktop is an empty one, not an error.

## Limits and deferred

- **No human live view or takeover.** Nobody watches or drives the desktop; the agent's screenshots are the only view.
  Streaming it to the console (VNC or WebRTC through the session API) and handing control to a person are separate designs.
- No audio, clipboard sync with the outside, GPU or file upload through the desktop; files go through `/workspace`.
- Three apps only. Adding one means changing the image and its skill.
- The image is large (about 1.9 GB uncompressed); that is why the flavour is off by default.
- The Playwright-style e2e suite for the flavour is not part of this change.

## Consequences

- A fourth value of `sandboxFlavour` is accepted by session-core, ingest (`GET /admin/sandbox-flavours` reports
  `desktopEnabled`, `PI_SANDBOX_FLAVOURS` lists `desktop`), the admin console's flavour select and the MCP admin profile
  schema, and refused while the chart leaves it off.
- Operators who enable it pay for a larger image pull on first use and a bigger Pod request while a desktop session runs.
