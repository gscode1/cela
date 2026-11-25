# 0065: Desktop sandbox: a virtual X desktop with a few apps, driven through accessibility

Status: accepted, 2026-11-23 (issues #405 spike, #408). The lab live view and the "no console live view" limit are superseded by [0066](0066-desktop-public-live-view.md). Builds on [0041](0041-browser-sandbox.md) (flavours; this is the
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
LibreOffice Writer and Google Chrome (the first version had Firefox ESR; see "Chromium and desktop-web", issue #452). It is behind `sandbox.flavours.desktop.enabled`, **off by default** (the image is large
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

Chrome (originally Firefox, which had the same rule through its enterprise policy) reaches the web only through the session's egress proxy, via the same loopback forwarder as the browser image
(`packages/browser-proxy`, 127.0.0.1:3129): `desktop-launch chrome` passes `--proxy-server` and refuses to resolve names itself, and its
managed policy disables telemetry, DNS over HTTPS, sync and the password manager. The seeded profile is `proxied` with the `open-web` rule
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

### Firefox runs without its own sandbox (superseded: Firefox was removed in #452; Chrome runs with `--no-sandbox` for the same reason)

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

### Lab live view

The image carries x11vnc and noVNC behind websockify (a few tens of MB of packages, mostly python3-numpy that websockify depends on; issue #413). `agent-desktop-run` starts them with the
desktop and restarts them on the next call, like openbox. x11vnc runs with `-viewonly`, so a viewer cannot send input
whatever its client does. Both listeners are bound to 127.0.0.1 (x11vnc on 5900, websockify and the noVNC files on 6080), so
nothing in the cluster can reach them and no NetworkPolicy, chart or API change is needed. A person with `pods/portforward`
RBAC runs `kubectl port-forward pod/<sandbox pod> 6080:6080` and opens `http://localhost:6080/`, which redirects to
`vnc.html?autoconnect=1&view_only=1&resize=scale`. There is no password: loopback plus that RBAC is the gate. Logs are in
`/tmp/pi-desktop/`. `PI_DESKTOP_LIVE_VIEW=0` in the sandbox environment turns it off. It works under runc; port-forward does
not work under gVisor (plan.md), so there is no live view there. The console view stays deferred.

### Token budget

Superseded in part by #452: the Firefox web helpers described below (`desktop-open`, `desktop-click`, `desktop-url`, `desktop-page`
without `--focused`, `--links`) are gone with Firefox; web pages are read by `desktop-web`. `desktop-page --focused`, `desktop-find`
and `desktop-shot` remain. The measurements and design reasons stay as history.

A raw snapshot is the expensive call. In one Allegro task a desktop agent used 2.84M tokens; 37% came from a single
`agent-desktop snapshot -i --compact` printed to stdout: 364 kB of JSON of which `dom_classes` were 21k characters,
`available_actions` 7.8k and the real names 3.1k. Pi kept the last 50 kB (offscreen nodes) and the agent re-read it every
turn; later snapshots failed with `RefMap exceeds 1MB`. Seven more turns went to copying the Firefox URL (no `xclip`), one to
`python: command not found`, and Node printed an `UNDICI-EHPA` warning into results. The image therefore ships `desktop-find`
(takes the snapshot, saves the JSON to `~/.agent-desktop-session/last-snapshot.json`, prints only `@ref role "name"` lines for
visible nodes matching a regex or role, a summary without a filter), `desktop-url` (ctrl+l, ctrl+c, `xclip`), `xclip`, `jq`,
a `python` link, and `agent-desktop-run` sets `NODE_NO_WARNINGS=1`. A heavy web page in Firefox overflows the 1 MB ref map
even at `--max-depth 8`, and `--root` refs inside web content are refused as ambiguous, so on that overflow `desktop-find`
falls back to `agent-desktop find` (one per `--role`, with `--text` when the pattern is a literal word) and filters it the
same way; without a filter it refuses rather than print a tree. On a large page one element without a stable identity or
bounds (offscreen, lazily rendered) makes a whole `find` fail with `STALE_REF`: on Allegro's all-offers page the unscoped and
the `statictext` finds failed while `heading`, `link` and `button` answered, and the agent spent about 20 calls in Ctrl+F and
screenshot loops (55 calls instead of 29). So the fallback skips a failing role and names it, retries a failing unscoped find
role by role over the roles an agent acts on (heading, link, button, textfield, combobox, checkbox: every find walks the whole
tree, about 7 s each on that page, and agent-desktop serialises parallel ones), and fails only when no role answered. `desktop-text` reads such a page without the tree: ctrl+l, Escape, F6
(focus into the page), ctrl+a, ctrl+c, saves the text to `~/.agent-desktop-session/last-page.txt` and prints matching lines
with one line of context. It gives text, not refs, and leaves the page selected until the next click; agent-desktop `get` on
the page's `webarea` returns only its title in Firefox, so the clipboard is the way. Neither change knows any site. Screenshots were the second cost (28 full-screen PNGs, about
31%): `desktop-shot` captures the focused window as an 800 px JPEG (about 500 image tokens instead of about 1,100) and prints
the scale and origin for xdotool clicks, and the skills say text first, a screenshot only to check layout or when the tree has
no answer, and one bash call per step (act, wait, check). The rule, in both skills: never print a full snapshot; use
`desktop-find`, or write to a file and filter it.

Three later runs of the same task (29, 55 and 31 model calls) still spent most calls on the same few patterns: each screenshot
is two calls (take it, read it) and there were 6 to 15 per run; clicks were refused as offscreen, then scrolled with keys and
searched again; every run opened with a role dump to find and dismiss Firefox's "Translate this page?" popup and a cookie
banner; prices were read through broad `desktop-find` calls; `desktop-url` left focus in the address bar, so the agent pressed
Escape, Tab and Page Down to get back. `desktop-text` was never used because the skill offered it only as a fallback. So:

- `desktop-page` (first named `desktop-text`, which stays as a link) is the default way to read a page: url, title and the
  matching lines in one call, then focus back in the page and the agent's clipboard restored.
- `desktop-click "regex"` finds the one matching link or button (one `find` per role with `--text` for the pattern's longest
  literal run, no result cap, since a page has thousands of links), clicks it and reports the new title. It clicks nothing
  when several match and lists them for `--nth`. agent-desktop's own scroll-into-view fails in Firefox ("The scroll viewport is
  not contained on one display"), so an offscreen target is brought into view with Firefox's find bar (its name typed, Return
  until it is on screen, Escape); if the click is still refused on screen, a mouse click at its centre. Waiting is on the window
  title, which costs no tree walk; an in-page change is reported as `(same)` rather than waited out. A click that times out while
  agent-desktop resolves the element on a very large page gets the same fallback. Candidates that all share one role and name
  (a product's image and title links) are one target and the first is clicked; different names stay the agent's choice. The
  Firefox keystrokes (`desktop-page` without `--focused`, `desktop-url`) refuse to run when Firefox is not the active window.
- `desktop-open URL ["regex"]` launches or navigates, waits on the title, copies again while the body has no text, and prints
  the same view as `desktop-page`.
- `desktop-url` ends with F6 (focus in the page) and restores the clipboard; `desktop-find` defaults to 25 lines and 80-character
  names; `agent-desktop-run -q` shortens an action's envelope to `ok click` or `ERR CODE: message`. The helpers share
  `desktop-lib.cjs`.
- Firefox: the translate popup and the speech-synthesis notice bar are off (policy preferences). Cookie banners are left to "I
  still don't care about cookies" 1.1.9 (GPL-3.0, AMO, pinned by checksum, force-installed by policy; every other extension is
  blocked). Measured in the lab on nine news and shop sites in six languages: with it, eight showed no banner; without it, all
  did. Firefox's built-in cookie banner handling (`cookiebanners.service.mode`) only rejects where it can, missed several
  of those sites even where its bundled list names them, and is left off. A hand-written list of "accept" labels was tried and
  dropped: it is a language list, and the button labels do not copy with the page text, so it could not tell when to act.
- No ad blocker. With uBlock Origin added, one shop served a blank page and another site a bot check, which neither did
  without it; the gain in tree size and page text was small. A real, ordinary-looking browser is the point of this flavour.

None of this knows a site: the same keystrokes, finds and extension run everywhere.

Nine cost runs after that change (three tasks, three runs) never used `desktop-open`, and on Allegro not `desktop-click`
either: 37 to 41 calls, worse than before, spent on `desktop-launch`, broad `desktop-find --all` reads and mouse-wheel
scrolling with screenshots. The desktop-sandbox skill still said to start apps only with `desktop-launch`, and the
agent-desktop skill led with the find-a-ref loop. The skills, DESKTOP.md and the flavour facts now lead with the three web
commands; `desktop-launch` and refs are for Mousepad and Writer; a list that loads on scroll is read with End or Page_Down and
`desktop-page`, not the wheel and a screenshot (a test keeps the order).

With the web loop in use, Allegro took 28 to 32 calls. What remained: the agent printed the saved page text with `cat` and
`sed` (hundreds of lines, four or five calls a run), and `desktop-click`, searching only links and buttons, could not reach a
control the page exposes as a switch, so the agent scrolled and clicked by coordinates from screenshots. `desktop-click`
without `--role` now makes one find across all roles for the pattern's literal text (one tree walk instead of one per role)
and keeps what a person can click (link, button, switch, checkbox, radio button, tab, menu item, option and the like), which
also wins over same-named plain text; when that find fails on a large page it searches those roles one by one. The skill
sends rereads of the saved text to `desktop-page --from FILE "regex"`. And reading a page no longer leaves it selected:
ctrl+a highlights the whole page until the next click, in screenshots and the live view. Escape, arrow keys, Tab and opening
and closing the find bar do not clear it; a find-bar search that finds nothing does, and moves nothing, when the search text
is pasted in one piece (typed letter by letter, find-as-you-type jumps to partial matches). `desktop-page`, `desktop-open` and
`desktop-click --show` do that after copying, then restore the clipboard.

An amazon.pl run then reported "no results" without seeing the broader search it asked for: Firefox autofilled the typed URL
`…/s?k=Haddrell` to the visited `…/s?k=Haddrell%27s+UMF25%2B`, and the page never changed. Address bar autofill is off
(`browser.urlbar.autoFill`), and `desktop-open` reads the address before navigating and says when the page is still there.
The same runs showed that the desktop profile's skills had never been republished: the skills an agent reads come from the
skill store, pinned by the profile, so a change to `images/sandbox-desktop/skills` reaches agents only after
`hack/seed-desktop-profile.mjs` (or the admin API) publishes it and the profile pins the new versions.

Three runs on the corrected skills (26, 36 and 47 calls) lost 38 of 109 calls in a panel of offers that share one title:
agent-desktop refused the click on a same-named link with `AMBIGUOUS_TARGET` (it cannot re-identify a ref among same-named
siblings), seven times, and the agent only wanted those offers' URLs. Firefox's select-all copy also puts the page's markup on
the clipboard (`text/html`) with absolute hrefs (lab: 1965 of 1966 links on a Wikipedia article, 114 of 114 on a shop
listing), so the page copy carries every link's URL in document order. `desktop-page --links` prints them after the matching
lines. `desktop-click` resolves same-named links through it: one URL is one target (an image link and its title link), and
different URLs are listed with each row's text instead of clicked. `--near TEXT` takes the occurrence in the row of TEXT: a
link starts its row, so the last occurrence at or before it, and is opened by its URL; a button ends its row, so the first at
or after it, matched to the same-numbered tree result (the tree's order followed the page for 98 of 112 pairs in the lab, so
the output names the occurrence it took). A whole-name match beats names that only contain the pattern, a link beats an option
of the same name, `AMBIGUOUS_TARGET` gets the same fallbacks as a refused click (the link's URL first), and the command stops at
45 s with a hint, under the agent's 60 s tool limit after which Firefox was seen gone. A fresh Firefox now starts on
`about:blank` and takes the URL through the address bar: given on the command line, `%20` in a query came out as a literal `+`
on one shop. The helpers run Node with `--no-warnings`, so the `UNDICI-EHPA` notice no longer lands in results.

### Chromium and desktop-web (issue #450)

Reading Firefox through select-all/copy and the AT-SPI tree gives text but no element refs, and the Allegro price-comparison task
took 18–28 tool calls. Firefox cannot be read over a protocol without being seen: `--marionette` or `--remote-debugging-port`
sets `navigator.webdriver` to true (the `dom.webdriver.enabled` pref no longer hides it on ESR 153), BrowserScan reports "Robot"
and DataDome answered Allegro, Etsy and Tripadvisor with a captcha in a lab run. The Firefox policy keeps
`DisableDeveloperTools`, which also keeps both off.

Chromium is in the image next to Firefox and is the default for web pages. `desktop-launch chromium` (now `chrome`) starts it with the same
egress forwarder, a fresh profile, a managed policy (`/etc/chromium/policies/managed/pi-desktop.json`: `file://` only under
`/workspace`, no translate, no sign-in or sync) and a debugging port on loopback. `desktop-web` (with `cdp-lib.cjs`) reads it
through that port without anything a page can detect: one short connection per command and only the methods in `ALLOWED`
(`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`, `DOM.getBoxModel`/`getContentQuads`/`scrollIntoViewIfNeeded`/
`getNodeForLocation`/`describeNode`, `Page.getLayoutMetrics`, `Browser.getWindowForTarget`). It never enables a domain, never
evaluates script and never sends CDP input; clicks and keys are X events from xdotool at the element's screen point, computed
from the window geometry and the layout viewport. A test fails when `desktop-web` sends a method outside `ALLOWED`.

Measured in the lab (Chromium 156, Xvfb, openbox): with this reader rebrowser's `runtimeEnableLeak` stayed green across about
170 calls, while one `Runtime.enable` turns it red for the rest of the page's life; sannysoft and BrowserScan ("Normal") pass;
Allegro's listing, consent dialog, offer and price worked without a captcha; clicks landed within 0 px on a test page.
`--no-sandbox` shows Chromium's "unsupported command-line flag" bar (the reader's geometry accounts for it; since #469 the
managed policy hides it). No
`--enable-unsafe-swiftshader`: rebrowser reads software WebGL as Playwright's default, so pages get no WebGL instead. The cookie extension is Firefox-only: in Chromium a consent dialog is one
`desktop-web click`. A click whose centre another element covers (a dialog) is refused with that element's name instead of
landing on it. Firefox and `desktop-open`/`desktop-page`/`desktop-click` stay for sites that misbehave in Chromium (superseded below).

#### Google Chrome replaces Chromium, Firefox is removed (issue #452)

Debian's Chromium fails rebrowser's `useragent` check: its `navigator.userAgentData` brands lack "Google Chrome", which a person's
Chrome always reports. The image now installs `google-chrome-stable` from Google's signed apt repository
(`https://dl.google.com/linux/chrome/deb/ stable main`, amd64 and arm64), with the signing key checked against its pinned fingerprint
`EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796` during the build; the repository's source file is removed afterwards, so later
`apt-get update` runs in the image do not use it and a new Chrome means a rebuilt image.

Chrome is pinned (issue #454). `ARG CHROME_VERSION` in `images/sandbox-desktop/Dockerfile` (default `158.0.8127.88-1`, so builds need
no extra argument) is installed as `google-chrome-stable=$CHROME_VERSION` through that same signed repository, so two builds of one
commit carry the same browser. Google's Packages index lists only the current build, so a pin expires within weeks; a build with an
expired pin fails early with a message that names the version and says to run the bump instead of apt's bare "Version was not
found". `.github/workflows/chrome-bump.yml` runs weekly (and on demand): `hack/chrome-bump.mjs` reads the amd64 and arm64 indexes,
and only when both list the same `google-chrome-stable`, newer than the pin, it rewrites the default and the workflow opens a pull
request (a lagging architecture waits for the next run). The PR is the review point: the desktop image must build and `desktop-web`
must still pass a detector page before it merges. Run `node hack/chrome-bump.mjs` locally to move the pin by hand; to rebuild at
another version, pass `--build-arg CHROME_VERSION=...` to `docker build`. `desktop-launch chrome` (`chromium` is an
alias) runs it with the flags above, and the managed policy moved to `/etc/opt/chrome/policies/managed/pi-desktop.json`. Firefox ESR is
removed, with its policy file, the cookie extension, `desktop-open`, `desktop-click`, `desktop-url` and the `desktop-text` link: web
pages go through `desktop-web` only, and two browsers meant two behaviours for the agent to choose between. The desktop keeps
Mousepad and Writer, `desktop-find`, `desktop-shot` and `desktop-page --focused` (copy the focused app's text).

### desktop-web reads and acts more like a person, in fewer calls (issue #455)

After a review (every change general: nothing about a site, a language or a task):

- **Budget.** Every answer is capped at about 60 lines or 4000 characters and says how to read on. `--limit` and `--context`
  are clamped, `text --lines A-B` pages through the saved text, and long blocks are wrapped into numbered lines instead of
  being clipped at 200 characters (the reason an agent dumped whole pages with `text '.*' --limit 400`).
- **Text from layout.** Pieces of text in one block are joined as a PDF extractor would: a space when their boxes sit on
  different lines, stand apart, or have a `br`, `img` or form field between them; none when they touch. Text with no visible
  box, entirely left of or above the page, `visibility: hidden` or under `opacity: 0` is left out, and so are such elements
  in `snap` and `click` (screen-reader-only text, honeypot links, hidden prompt injection).
- **Feedback.** `click`, `type --enter` and `key` print what changed: the new page's heading outline, or the lines that
  appeared. Waiting ends when the page's text holds still (not its height), or when `--show`'s regex matches. `open` without
  a regex prints the headings with line numbers.
- **Dialogs.** Open `dialog`/`alertdialog`/`aria-modal` elements are listed by `open`, `snap`, a refused click and after
  actions, with their buttons' refs, in whatever language the site uses. The Firefox cookie extension is not replaced: it is
  a per-site rule list.
- **Refs.** `snap` records each ref's role and name; a click by ref whose element changed or is gone is refused.
  `snap` lists the `main` landmark first. A button only loses to a link when its name contains the link's.
- **Input.** Typing goes in short bursts at a typing pace, the pointer travels in a few steps to a point near the middle of
  the element, dwells and holds the button; URLs and non-ASCII text are pasted. `type` reads the focused field back.
- **Port.** Chrome's debugging port is random per launch (`$PI_DESKTOP_STATE/cdp-port`). Not `--remote-debugging-port=0`:
  with it Chrome 158 reports `navigator.webdriver = true`. `Browser.getWindowForTarget` left `ALLOWED` (unused).

### desktop-web test suite and what it found (issue #458)

`hack/desktop-web-suite.sh` drives `desktop-web` over local pages (`images/sandbox-desktop/test-pages/`, not in the image) and
checks outcomes from the pages' own text: every page logs a click as `clicked: <id> at x,y`, read back with `desktop-web text`,
so nothing is injected into a page. Cases: page zoom 125% and 80%, a horizontal scrollbar, a sticky header and footer, an element
far down, a 12 px target, a dialog over content, open shadow DOM, same-origin and cross-origin iframes (also with the button below
the frame's fold and a 1 px frame), hidden links and text (offscreen, opacity 0, `visibility`, screen-reader-only clip), and text
spacing. To run it, copy the pages and the script into a container of the desktop image (or a sandbox pod) and run it there:

```
docker cp images/sandbox-desktop/test-pages <container>:/workspace/web-suite
docker cp hack/desktop-web-suite.sh <container>:/workspace/
docker exec <container> bash /workspace/desktop-web-suite.sh [case...]
```

It serves the pages with two `python3 -m http.server` on loopback; the cross-origin frames come from `127.0.0.2` (another
address is another site, so Chrome puts the frame in its own process, and a name such as `localhost` would not resolve in a pod,
where the egress proxy flags map every name but `127.0.0.1` to "not found"). Waits are generous (`SUITE_WAIT`, 240 s per call)
because gVisor is several times slower than runc. Every fix below is general, none names a site, language or task:

- **Horizontal scrollbar.** `clientHeight` leaves it out, and the viewport's top is found from the full height, so every click
  landed one scrollbar's thickness low. The thickness is now measured: hit testing covers the whole page area, so the first
  point below `clientHeight` that hits nothing is the bottom (`scrollbarThickness`).
- **Iframes.** `Accessibility.getFullAXTree` covers one frame only. A frame of the same process is read with its frame id from
  `Page.getFrameTree`; a frame of another site is a separate target of type `iframe` in `/json/list`, read through its own short
  connection, and its boxes are placed in the page by its iframe element's content box (`DOM.getFrameOwner`, `DOM.getBoxModel`).
  Refs of such an element end in `@TAG` (`e12@A1B2`). Clicks check for a cover at each frame on the way. An iframe whose element
  a person cannot see is left out like any hidden element. At most 10 out-of-process iframes are read per command. Both added
  methods only read and enable nothing; the detector page stayed green (below).
- **Clipped text.** Text cut away by an `overflow: hidden`/`clip` ancestor (a collapsed accordion) or its own `clip: rect()`
  (the usual screen-reader-only pattern) is left out of `text` and `snap`, as offscreen and transparent text already was.
  Scrollable boxes do not cut: their content is one scroll away.

Two inline-blocks on one line read as two lines of text; that is deliberate (a row of cards or tabs), the suite pins it.
(Superseded by #469: an inline-block whose text sits on one visual line with other text of its block joins that line; cards
and columns still stand apart.)

### No proxy sign-in dialog, no background calls (issue #460)

The egress proxy refuses a host with 407, and the browser-proxy forwarder passed it on unchanged. Headed Chrome answers any
407, also one for a tracker a page loads, with a modal "Sign in: the proxy requires a username and password" dialog: browser
UI that `desktop-web` cannot see and that blocks clicks. The forwarder adds the session's credentials itself, so a 407 can
only mean refused: it now rewrites it to 403 without the `Proxy-Authenticate` challenge, keeping the body. Chrome is also
started with `--disable-background-networking --disable-component-update`, which ends its own calls to Google's update,
account and variation services through the session's proxy.

### desktop-web: blocked pages, dropdowns, waits, hover, shots, marks (issue #462)

Live runs on a public practice site with native controls showed where `desktop-web` still cost calls: about 20 calls to pick an
option in a native `<select>` (the popup is browser UI the reader cannot see, so the agent clicked and arrowed by hand), `sleep 6`
loops for content that appears later, raw `xdotool mousemove` to hover, and minutes lost on a JS `confirm()`: while a JS dialog
is open the renderer is blocked, `DOMSnapshot` and `getFullAXTree` hang until the 20 s timeout and `desktop-web` said nothing
(measured here: a click on a confirm button returned nothing for more than 60 s). On a book shop's listing the star ratings exist
only as a CSS class, so the agent took nine screenshots. Every change below is general: no site, language or task is named, the
reader stays passive (`ALLOWED` is unchanged: no new method, no `Runtime`, no `*.enable`, no script in a page, no CDP input) and
all input is still real X events through xdotool.

- **Blocked page.** Every command first checks that the page answers: `/json/list` lists the target but
  `Page.getLayoutMetrics`, answered by the renderer, does not come back within 2.5 s. `settle` checks once after a second and
  again whenever a read fails, so a click that opens a dialog says so after about 3 s instead of hanging. The notice does not
  over-assert (a dialog is "probably" open, "or the page is busy") and carries the way out: `desktop-web key Return`,
  `desktop-web key Escape`, and for a prompt `desktop-web key --text "answer" Return` (`--text` types, as a person does, into
  the focused dialog field, replacing a default). `key` used to read the page before sending its keys, so Return never reached
  the dialog; it now reads nothing while blocked (the last saved text stands in as "before"), sends the keys, probes again and
  prints `dialog closed` with what changed or `Still blocked`. Chrome draws these dialogs itself and they are in the AT-SPI
  tree while the page is stuck: `agent-desktop-run snapshot --app chrome --timeout-ms 3000` returns a window "<origin> says"
  with the message (the dialog node's description), buttons (the default one focused) and a prompt's field, so the notice prints
  the message as text (about 2.5 s, no new Chrome flag). When it finds none, the notice captures where such a dialog sits (top
  centre of the window, under the toolbar) with `desktop-shot --region` and prints the path. `activate` now does nothing when
  Chrome's window already has focus: `windowactivate` on it would close a dropdown popup (a separate grab window).
- **Dropdowns.** A closed select's options are nodes of the layout snapshot already read (`optionSelected`, the `disabled`,
  `hidden`, `label`, `multiple` and `size` attributes): `snap` prints `combobox "Name" value="..." options: A | B | C`, cut by
  count and length with `(+N more)`, and a hint. `desktop-web select <ref|"regex"> "option"` matches exact text, then ignoring
  case, then as a regex, and lists an ambiguous match. For a native single select it clicks once (the popup opens), counts the
  Up/Down presses over enabled options from the selected one, presses Return (one `change`, never one per step, and no arrows on a
  closed select) and reads the value back. A `multiple` or `size>1` select and ARIA comboboxes or listboxes clicks the control if
  it needs opening and then the option element matching the text.
- **Waiting.** `desktop-web wait "regex" [--gone] [--timeout N]` (N at most 60, default 20) polls the page text and prints the
  matching lines. After a click, key, select or Return the answer ends with `result may come later: desktop-web wait "regex"` when
  nothing changed (since #467: no line, dialog, alert or control state) or the tree shows a `progressbar` or `busy=true`. `key` takes `--show` like `click`.
- **Hover and shots.** `hover` is `humanClick` split into a move and a press (`desktop-lib`), reusing the click's resolve,
  scroll and covered-by checks, with a dwell before it prints what appeared. `shot <ref|"regex"> [--pad N]` scrolls the element
  into view, maps its box to screen pixels like a click and calls `desktop-shot --region` (no `Page.captureScreenshot`); hover and
  shot also find named images and groups.
- **Marks.** `text "regex" --marks` (opt-in, never the default, and the saved page text stays plain so line numbers keep their
  meaning) writes elements that have a visible box but no text and no accessible name into the line where they sit, as
  `‹class words title:"..." data=value src:file.png›` from their markup: the outermost such element, else its first descendant that
  has any words, generated-looking class names left out, at most 200 per page. It is a fallback before `shot`.
- **Skills.** A web task needs only the desktop-sandbox skill (agent-desktop is for Mousepad and Writer); no raw `xdotool` or
  `sleep` on a web page; a meaning shown only by an icon, colour or image goes `--marks`, then `shot`; "build URLs" became "a URL
  pattern you have seen on this site"; the line that implied JS alerts are listed with refs is replaced by how the browser's own
  dialogs behave.

The suite gained `dialogs`, `select`, `wait`, `hover`, `marks` and `shot` cases (test pages `dialogs.html`, `selects.html`,
`later.html`, `hover.html`, `marks.html`), and unit tests cover option parsing, matching, arrow counting, marks and the AT-SPI
dialog reading.

### desktop-web: label-backed and text targets, state after actions, names, validation, stale refs (issue #467)

Hard local runs (a hotel search, a shop's filters, practice forms, a map's route panel) failed on general gaps. The reader stays
passive (`ALLOWED` unchanged; everything below uses the accessibility tree and layout snapshot already read, plus the `cursor`
computed style), input stays real X events, and nothing names a site or language.

- **Custom checkboxes.** Such controls keep the real input at opacity 0 or 1 px and draw the box in a `<label>`; the hidden-element
  filter dropped them like honeypots. A hidden checkbox, radio or switch is now kept when its own label (an ancestor, or `for=`)
  is visible, and clicked on the label; its state still comes from the input's accessibility node. A hidden input without a
  visible label stays out.
- **Clickable text.** When `click "regex"` matches no element, it clicks the one visible line whose element shows a pointer
  cursor or is marked clickable by the snapshot (role-less options). Text inside a listed element, or around one (a label), is
  that element's. `snap "regex"` lists these as `clickable "text"`; a plain `snap` does not.
- **State after the action.** `click` reads the element again after the page settles (`radio "Male": checked false -> true`).
  The answer also reports lines that went, dialogs that closed, new `alert`/`status` text and up to five other controls whose
  `checked`, `expanded`, value or name changed. The "result may come later" hint appears only when none of that changed or the
  page is busy; a link click that kept the address says so. `type` prints `value now` (also with `--enter`), exits 1 when the
  field kept its value (read-only), and without `--enter` shows at most five new options or lines (an autocomplete, a
  debounced filter).
- **Names.** A field's `placeholder` is printed and matched. A control whose name has no letters gets the words of its markup
  (`button ‹tool icon-bike›`, as `--marks` does), else the text of its row (`combobox "" near "State Select state"`); both are
  matched by a regex. Disabled controls are listed as `disabled` and a click refuses them (exit 1). When `open` or `text`
  finds no line, elements whose name or placeholder matches are listed.
- **Validation.** Entries show `required`, `invalid`, `readonly` and the accessible description (`desc=`, the
  `aria-describedby` error). An answer where nothing else changed lists the invalid fields.
- **Stale refs.** A ref whose element the page replaced is found again by the role and name remembered from the listing when
  exactly one element has them, and the answer says so.
- **Chaining.** The skill tells the agent to chain independent steps with `&&` by regex; the exit codes above stop a chain.

The suite gained `custom`, `state`, `names`, `form` and `stale` cases (pages `custom-controls.html`, `state.html`,
`names.html`, `form.html`, `stale.html`).

### desktop-web: sliders, file upload and the file chooser, drag (issue #468)

The same hard runs found three things `desktop-web` could not do. The reader stays passive (`ALLOWED` unchanged), and input
stays real X events at a person's pace. `DOM.setFileInputFiles`, `Input.dispatchDragEvent` and
`Page.setInterceptFileChooserDialog` would be simpler, but they are not input a person makes and are not used.

- **Sliders.** `snap` lists `slider "Volume" value=25 min=0 max=100` from the accessibility node's value, `valuemin` and
  `valuemax` (`valuetext` when it differs, `vertical`); an unnamed one gets its row text like other controls. `type <slider> 75`
  presses at the value's proportional point: on the slider itself when it is its own track (a native range: the travel is inset
  by half a thumb), else it drags the thumb along its track (the nearest ancestor in the layout snapshot several thumbs long).
  It reads the value back, then presses the arrow keys (the first press learns the step) and reads back again: `value 25 -> 75`.
  A value between steps ends on the nearest and says so; a slider that did not move or stopped elsewhere exits 1.
- **File chooser.** A click on a file input opens Chrome's GTK file chooser, a second top-level window of Chrome
  (`_NET_WM_WINDOW_TYPE_DIALOG`, transient for the browser window). It does not block the renderer, so a JS-dialog probe misses
  it, but it takes all input. `chromeWindow()` now skips such windows, and every command reports one, as for a JS dialog: reads
  go on with the notice, actions exit 3, `key` sends its keys to the chooser (`Escape` cancels it).
- **Upload.** `desktop-web upload <ref|"regex"> /workspace/file` checks the file exists, clicks the target (a file input, or a
  button that opens a hidden one), waits for the chooser, then `ctrl+l`, types the path, `Return`. It reads back the file inputs
  of the layout snapshot (`inputValue`, so a hidden input counts) and what changed on the page. A chooser that stays open is
  cancelled. `type` on a file input is refused with a pointer to `upload` (it used to type into the chooser's search).
- **Drag.** `desktop-web drag <src> <dst>` or `--by dx,dy` places both elements (any visible text is a target, as a drop zone
  needs no click listener), then moves to the source, presses, leaves the press point by a few px, travels in eased steps with
  a slight wobble, dwells and jiggles over the target and releases. Both a pointer-event drag and HTML5 `draggable` with `drop`
  work under Xvfb: Chrome runs its X drag session on the XTest motion events.
  A `grab` or `move` cursor now marks clickable text as `pointer` does.
- `xdotool type` read a burst of text that starts with `-` as an option; text now follows `--`.

The suite gained `slider`, `upload` and `drag` cases (pages `slider.html`, `upload.html`, `drag.html`).

### desktop-web: page notices, text layout, the flag infobar (issue #469)

The hard runs read pages whose answers wasted tokens or hid what the page was: the full URL in every answer, titles with
`&amp;`, a redirect or a 404 reported as an ordinary page, a bot check found only by reading its text, inline values on lines
of their own and an outline out of order. The reader stays passive: `ALLOWED` is unchanged and nothing below takes a new
method. In particular there is no HTTP status: reading it would take `Network.enable`, which a page can detect.

- **Header.** An answer prints `url:` only when the address changed since the last answer (kept in the session directory as
  `web-url`), cut to 120 characters; `desktop-web url` prints it whole. Titles have their HTML entities decoded (`/json/list`
  escapes them). Notices follow the title, from data each command already reads:
  - `redirected from X` when `open` ends on another origin or path than the URL typed (a query a page rewrites in place does
    not count);
  - `Chrome error page` when the main document is `chrome-error://`;
  - `may be an error page` when an HTTP error status stands at the start or end of the title or the first visible h1 of a page
    of at most 150 lines (a site's 404 keeps its menus and footer);
  - `looks like a bot check (<provider>): report it, do not retry` when a page of at most 40 lines shows a visible frame of a
    challenge provider, known by the frame's URL host: Cloudflare challenges, hCaptcha, reCAPTCHA (not its invisible badge),
    DataDome, HUMAN/PerimeterX, Arkose. The list names providers, never sites;
  - `a frame is still loading` when a visible frame of at least 100x50 px has drawn nothing yet (no text, no element box).
- **Settling.** `captureSnapshot` is asked a second time when the first times out. A page of one or two lines must hold still
  for three reads, and when every read of `settle()` failed one more read is made, so `open` never reports "0 lines" of a page
  that has text.
- **Outline.** `snapshotText` maps each element to the first line holding its text, and the outline maps a heading by its node,
  sorted by line. A heading with no visible line (screen-reader-only) is left out, where it used to read `-:`; matching by the
  heading's first words had put headings at the wrong line and out of order.
- **Inline boxes.** An inline-block, inline-flex or inline-grid box (and the items of an inline flex or grid) joins the line
  around it when all its text sits on one visual line (no fragment of it wraps, from the snapshot's text boxes, and it holds no
  block) and that line overlaps text of its block outside it: `Distance: 13km. Time: 0:22.` A card or a column of
  inline-blocks spans several lines and stays apart. Buttons side by side now read as one line; a click by text aims at the
  piece of the line that matches.
- **Marks in the text.** Struck-through text (`text-decoration-line`, now in `STYLES`, drawn through descendants, so the
  ancestors are read) reads `~637 zł~`. A line without letters gets the aria-label or title of the nearest element around it
  that is not much larger than the text: `94 ‹Upvote›`; a toolbar named as a whole names no number in it.
- **`text --indent`** prefixes each line with `>` per level, counted from the left edges that several lines share: replies in a
  thread. Columns side by side read as levels too, so it is opt-in.
- **Infobar.** `--no-sandbox` stays (the sandbox runtime is the boundary). The managed policy sets
  `CommandLineFlagSecurityWarningsEnabled: false`, which hides the "unsupported command-line flag" bar; `--test-type` would hide
  it too, but it is a switch for Chrome's own tests and is not used.

The suite gained `infobar` (Chrome's accessibility tree holds no such bar) and `notices` cases (pages `notices.html`,
`redirect.html`, `missing.html`, `challenge.html`, `loading.html`, a local server that never answers), and `spacing` and
`marks` cover the text changes; `spacing` now expects `eta theta` as one line.

### desktop-web: a control's own decoration, labels, scoped dropdowns, "nothing happened", form hints (issue #473)

Round 2 of the hard local tests (a shop's filters and sort control, a practice form, a payment demo, a map's directions form).
Reading stays passive and input stays real X events; nothing here knows a site, a language or a host.

- **Own decoration.** `annotate` records a control's visible `<label>` (`labelEl`, also when the input itself is visible) and
  its own box (`boxEl`): the highest ancestor, at most three levels up, that holds no other listed control. The covered-by
  check accepts a hit inside either, so a sibling's or a `for=` label's `::before` drawn over the input no longer refuses the
  click; the `checked false -> true` read-back is the proof. Anything else in front is still refused, and the refusal names
  the dialog the hit is in and says to run the rest of the chain again.
- **Labels.** A field or slider without a name in letters gets `label "…"`: the text ending just left of it on its height
  (words of the line before it), else the nearest short line just above it, never text drawn inside it. It is matched by a
  regex (and counts as an exact name); markup words (`‹…›`) are printed only when there is no label and no row text.
- **Dropdowns.** `select` on an in-page dropdown takes the options it owns (its subtree and what it names in
  `aria-controls`), else options that appeared as it opened, else the lines of text that appeared (a list without roles),
  clicked as text. It never falls back to every option of the page (a menu elsewhere). On a failure it presses Escape to close
  the popup it opened and says when the address changed all the same. An answer lists new options with refs, and `hover` and
  `shot` take any visible text as a target.
- **Nothing happened.** "result may come later" appears only when the page shows it is busy (a progress bar, `busy`).
  Otherwise an action after which nothing changed (no text, state, dialog or address change) says `nothing happened`, lists
  invalid and required-but-empty fields and how to look (`desktop-web shot <ref>`); the same no-op on the same control and
  address twice in a row (a session file) says to stop clicking it. `type --enter` counts the field's own new value.
- **Forms.** Of several fields matching `type`, the one outside the banner and navigation landmarks is used, and the answer
  says so (`--near` picks another). A field in a `<form>` with no visible button says to use `--enter`. A new address that
  keeps the path (only the query or fragment changed) or more than half the page's lines prints what changed, not an outline. `type ""` clears a field
  (ctrl+a, BackSpace).

The suite gained `decor`, `dropdown` and `acting` cases (pages `custom.html`, `dropdown.html`, `acting.html`).

### desktop-web: bot-check revisit, notices, collapsed text, flex prices (issue #474)

Round 2 of the hard local tests again (a forum's bot check, a payment demo, a shop's product page). Reading stays passive:
`ALLOWED` is unchanged, nothing runs in the page, and nothing here knows a site, a language or an ad or tracker host.

- **Bot check.** A bot check can be a one-off (the forum's cleared on a later visit), but working around one is not ours to
  do. `open` counts bot checks per host in the session directory (`web-bot-checks.json`). The first sight reads
  `looks like a bot check (<provider>): never click or solve it. It can be a one-off: open one ordinary page of the site (its
  home or section page), then this page once more.`; any later one on that host reads `bot check again (<provider>, 2nd time
  on <host>): stop and report it. Do not retry, wait it out, or try other addresses or mirrors.` `click`, `type` and `drag`
  refuse an element inside a frame whose URL, or whose iframe element's `src`, is a challenge provider's (the list of #469),
  and exit 1 with "that is the bot check's own widget". The skill's rule: no alternate hosts, JSON endpoints or caches; one
  ordinary revisit through the site's own pages, then report and stop.
- **Frame still loading.** An out-of-process frame counts only when its iframe element shows a box (laid out, not
  `visibility: hidden`) and its document has a root box of at least 100x50 px; a document with no layout at all no longer
  counts. The payment demo's hidden fraud frames said "still loading" in every answer. The notice is said once per page URL
  (`web-loading-said`).
- **Non-modal dialogs.** A dialog without `aria-modal` (a `<dialog open>`, a panel with the role) reads `open dialog "X" (not
  modal):`; an alert dialog or a modal one still says "act on it first". The covered-by check is unchanged.
- **Error pages.** The status set is 400 to 408, 410, 429, 451 and 500 to 530 (Cloudflare's 52x). It is matched at the edge of
  each part of the title (split at `|`, `:` and a dash between spaces: "x | 522: Connection timed out"), of each visible h1 to
  h3, and as a line among the first 40 that is only the status or one word and the status ("Error 404"). A price line ("404
  zł") is not one. A dash inside a word does not split ("Wi-Fi 500 Mbps").
- **Collapsed text.** Text a box with `overflow: hidden` cuts away entirely is still left out of `text`. When a regex matches
  no line, `text` counts the blocks of cut text that match and says `N matches are in a cut-off section (text not shown)`,
  with the control that opens it: a collapsed one (`expanded=false`) in or just below the cutting box, else the button or link
  just below it. Only a box that itself shows (at least 20 px each way) counts, so screen-reader-only text is never reported,
  and the cut text is never printed.
- **Flex prices.** The items of a flex row (which compute to `block`) join the line when an item's text stands within 0.6 of
  a line's height of the next item's text, all on one visual line. They are always joined with a space ("699 00 zł", never
  "69900"), except before a piece that starts with a comma or a point ("145,95"). The gap is measured between the texts, so
  padded tabs stay apart, and a link, button or field never joins (a "50 zł off" badge beside a price is a button).

The suite gained `errors`, `challenge` and `collapsed` cases (pages `timeout522.html`, `body404.html`, `listing.html`,
`collapsed.html`; `challenge.html` now draws a widget through `srcdoc` under the provider's `src`), and `notices` (pages
`hidden-frame.html`, `blank.html`, `nonmodal.html`) and `spacing` cover the rest.

### desktop-web: sortable headers, duplicate preference, wider matching, closed menus (issue #477)

Round 3 of the hard local tests (a sortable wiki table, an issue tracker's overflow menu, a shop's duplicate controls, a
practice form, a drag demo, a form's scale). `ALLOWED` is unchanged, input stays real X events, and nothing knows a site or a
word list.

- **State read.** `axEntries` reads `selected`, `pressed` and `hasPopup`; Chrome's accessibility tree has no sort property,
  so `annotate` reads `aria-sort` from the layout snapshot. `selected`, `pressed` and `sort` are printed and diffed.
- **Sortable headers.** Named column headers are read; one is kept only when it has `aria-sort`, is focusable, has a click
  listener or a pointer cursor. Headers that share a name get the header above them whose span covers theirs:
  `columnheader "Population" in "City proper" sort=none`, matched as "City proper Population". A control that holds other
  listed controls (a footnote link in a header) is clicked at a point of its own box away from them, confirmed by
  `DOM.getNodeForLocation`; otherwise at its centre.
- **Duplicates** are settled in `chooseTarget`, in order, each automatic pick with a note: an exact name (or, with none, the
  one text line that reads exactly so) over substring matches; matches in an open modal; for `type`, the field outside the
  banner and navigation (moved here); twins (same role, name, group, row text, enclosing group names and heading before
  them) by the one in the viewport, else the first in the main content. Anything else is listed (exit 2).
- **Matching.** A regex also matches the description and, for an unnamed control, its role word; `snap` tests what a target
  is matched by, so anchors work. `--near` also matches the names of group, radiogroup, row and listitem ancestors and the
  last heading before the control, in the page's order.
- **Closed menus.** A `snap`, `click` or `text` that finds nothing lists up to four controls with `aria-haspopup` or
  `expanded=false` that may hold it, icon-only ones and menus first, with refs. Nothing is opened.

Reorder detection, focus after keys, nearly empty pages, `text --table` and the modal Close timing are deferred to the next
change. The suite gained `table`, `twins` and `menu` cases (pages `table.html`, `twins.html`, `menu.html`) and `names`
grew (description, role word, scales under headings, anchored `snap`).

### desktop-web: reorder and selection count as changes, focus after keys, nearly empty pages, text --table (issue #478)

The rest of round 3: answers that said "nothing happened" after a sort, a drag swap or a filter option that applied, a `key
Tab` that did not say where the focus went, a shop's error page of one line that nothing flagged, tables read as one long
line per row, and a dialog's Close that missed. `ALLOWED` is unchanged, input stays real X events, nothing is retried and no
key is pressed on the agent's behalf.

- **Order.** `changes()` compares the order of the lines both reads hold once each (`orderChange`); lines that show more
  than once are left out, since which copy moved cannot be told. A different order is a change, printed as `order changed
  (lines A-B), now:` and at most 8 lines of that range as they read now. Lines that appeared or went do not count.
- **The clicked control.** It is read again by its ref, else by its role and name when one element has them (the page drew
  it anew, as a filter's option list does): its `selected`, `pressed` and `sort` changes are printed, `the page drew it again:
  now [e..]` says so, and a redraw or a control gone from an unchanged address is a change.
- **Focus.** `key` prints `focus: <element>` when the focused element changed (`focusOf`: an entry with its ref, else the
  accessibility node's role and name); that is a change too.
- **Nearly empty pages.** `pageNotices` says `page shows almost no text (N lines, no form field): an error or block page, or
  a picture-only one; look with desktop-shot` for an http(s) page of 1 to 3 lines and at most 200 characters with no input,
  textarea or select that shows a box, when no other notice (Chrome's error page, a status, a bot check) already names it.
  It knows no words. It points to `desktop-shot`, the whole window, not `desktop-web shot`, which needs a target.
- **`text --table`** (opt-in; the default text is unchanged): a table row reads as its cells joined by ` | `, empty cells
  kept and spans not resolved, and the header rows (all `th`, or in a `thead`) of the tables the matches are in are printed
  once above them as `cols: ...`. Its line numbers are its own (`--table --lines A-B` pages on); the saved text stays plain.
- **Steadier clicks.** `placeNode()` reads the box again 150 ms later and keeps reading while it moves, for at most a second,
  so a dialog that slides in is clicked where it stops. A native `select` whose read-back disagrees is read once more after
  700 ms (a page that re-renders as it takes the change) before it exits 1.

The suite gained `reorder` (a drag swap, a sort button, an `aria-selected` option in place and in a list drawn again, Tab
focus), `empty` (a one-line page flagged, a one-line page with a search box clean) and `slide` (a Close button in a dialog
that slides in, clicked in a chain right after the opening), and `table` checks `text --table`.

### desktop-web: double click, plain-text clicks, hidden toggles, focusable handles, appeared controls, scroll (issue #481)

From round 4, on sites the tool had not met (a TodoMVC, jQuery UI demos, react-select, a shop's virtualized list). `ALLOWED`
is unchanged, input stays real X events, and nothing is retried.

- **Diffs.** `newLines()` counts lines, so a line already shown elsewhere ("Red" in a second multi-select) is new when it
  shows more often. `changes()` prints `appeared: [e..] <control>` for controls whose role and name count grew (a new ref
  first, then a new row), at most 5, only a count above 8; options and an open dialog's controls are printed as before. A
  click reports the focus when another element than the clicked one took it. `key` prints `scrolled Y1 -> Y2 of H px` from
  `Page.getLayoutMetrics`, and that is a change.
- **Listing.** A checkbox, radio or switch hidden only by opacity 0, without a label a person sees but with a box of at least
  8 px, is kept and clicked on its own box (TodoMVC's toggles); the hit test still refuses one that is covered, and a 1 px
  honeypot stays out. An element of another role with a `tabindex` of 0 or more in its markup, that does not scroll and holds
  no listed control, is listed as `focusable ‹class words› near "row"` (a jQuery slider handle); its row is the nearest
  text around it when its own has none. `tabindex=-1` elements and scrollers are never listed. Controls that share a role and
  name show their row as `near` (40 characters), which `--near` matches and a name regex does not. `type` refuses a
  focusable handle: the skill says to click it and use keys or `drag --by`; no step is guessed.
- **Click.** `click --double` presses twice 60-120 ms apart and takes any visible text. A plain `click` that matches no
  element and no clickable text takes the one visible line that matches (or reads exactly so) and says so; several are listed
  by ref. A ref of a text line is found again by its text, like a clickable one.

The suite gained `chips` (a pick that repeats a line and adds a second "Remove Red", `key End` scrolled), `todos` (opacity-0
row toggles by `--near`, a plain-text click, a label renamed after `--double`) and `handle` (two role-less handles listed,
moved with an arrow key; `tabindex=-1`, a scroller and a card with a link left out).

## Limits and deferred

- **No console live view and no takeover.** The only live view is the lab one below; the console view (VNC or WebRTC through
  the session API) and handing control to a person are separate designs.
- No audio, clipboard sync with the outside or GPU. A page can take a file only from `/workspace`, through `desktop-web upload`.
- Three apps only (Chrome since #450 and #452; Firefox was removed). Adding one means changing the image and its skill.
- The image is large (about 1.9 GB uncompressed); that is why the flavour is off by default.
- The Playwright-style e2e suite for the flavour is not part of this change.

## Consequences

- A fourth value of `sandboxFlavour` is accepted by session-core, ingest (`GET /admin/sandbox-flavours` reports
  `desktopEnabled`, `PI_SANDBOX_FLAVOURS` lists `desktop`), the admin console's flavour select and the MCP admin profile
  schema, and refused while the chart leaves it off.
- Operators who enable it pay for a larger image pull on first use and a bigger Pod request while a desktop session runs.
