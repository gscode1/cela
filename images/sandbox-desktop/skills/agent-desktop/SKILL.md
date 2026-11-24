---
name: agent-desktop
description: "agent-desktop 1.3.1 reference: accessibility refs, snapshot, click, type, press, get. For Mousepad and LibreOffice Writer. Web pages go through desktop-web in Google Chrome (desktop-sandbox skill)."
---

# agent-desktop 1.3.1

Reads and operates apps through their accessibility tree. Each command prints one JSON envelope (`ok`, `data` or `error`); `agent-desktop-run -q <command>` prints one line instead. Always run it as `agent-desktop-run <args>`. `agent-desktop-run <command> --help` lists the flags.

**Web pages do not start here.** Use `desktop-web open <url>`, `desktop-web text "regex"`, `desktop-web snap "regex"` and `desktop-web click <ref|"regex">` in Google Chrome (desktop-sandbox skill): one call each, a few lines of text, with its own refs. agent-desktop refs do not reach Chrome.

## Never print a full snapshot

A raw snapshot is hundreds of kB of JSON (class lists, offscreen nodes) that you re-read on every turn. Use `desktop-find`: it saves the snapshot to a file and prints only matching nodes, `@ref role "name"`.

    desktop-find --app mousepad                          summary: windows, counts by role
    desktop-find --app soffice.bin "Save|Bold"           regex on name/value, any case
    desktop-find --app mousepad --role textfield --limit 10
    desktop-find --from /home/pi/.agent-desktop-session/last-snapshot.json "price"   filter the saved file again, no new walk
    --skeleton, --root @ref, --max-depth N narrow big trees; --all adds offscreen nodes (keep --limit small)

Never run `snapshot` without redirecting it.

## Loop for Mousepad and Writer: observe, act on a ref, verify

1. `desktop-launch mousepad|writer` once, then `desktop-find --app <name> <regex>`. App names: `mousepad`, `soffice.bin` (Writer). `list-apps` shows what runs.
2. Large app (Writer has about 1500 refs): `desktop-find --skeleton --app <name>` first, then drill into one region with `desktop-find --root <ref> --app <name> <regex>`. A very large tree overflows the snapshot (`RefMap exceeds 1MB`) and `--root` inside it can be refused as ambiguous: then give a regex or `--role`, and `desktop-find` switches to `agent-desktop find` by itself (a literal word is faster than a regex).
3. Act on a ref from that snapshot. A ref belongs to one snapshot: after the UI changes, snapshot again (`STALE_REF`, `SNAPSHOT_NOT_FOUND`).
4. Verify the effect with `get <ref> --property value|text|states` or one new `desktop-find`. Take one snapshot per step: every call walks the whole tree and costs seconds.

## Commands

- `snapshot` (via `desktop-find`; redirect it to a file if run directly): `-i` interactive nodes only, `--compact`, `--skeleton`, `--root <ref>`, `--max-depth N`, `--window-id <id>`, `--surface menu|sheet|alert`.
- `find --app <name> --role <role> --name <text>`: search by role or name; it walks the tree too.
- `click`, `toggle`, `check`, `uncheck`, `select`, `expand`, `collapse`, `scroll-to`, `clear`, `set-value`: act on a ref, headless.
- `type <ref> "<text>"`: inserts text into a field.
- `press <combo> --app <name>`: keys such as `ctrl+s`, `return`, `ctrl+l`. Run `focus-window --app <name>` first, or the key goes to the wrong window.
- `double-click`, `hover`, `drag`, `mouse-click --xy X Y`, `scroll`: physical input, `--headed` only.
- `get <ref> --property text|value|title|bounds|role|states`, `is <ref> visible|enabled|checked|focused`.
- `screenshot --app <name>`: full-size PNG of one window; prefer `desktop-shot` (small JPEG, desktop-sandbox skill), and only when text from `desktop-find` or `get` is not enough.
- `list-apps`, `list-windows --app <name>`, `focus-window`, `resize-window`, `close-app`.
- `status`: permissions and version. `batch`: several commands in one call.

## Timeouts

The tree walk is slow in a sandbox. Pass `--timeout-ms 60000` on `snapshot` and `find`, `--timeout-ms 30000` on `type` and other actions. A snapshot that returns `complete: false` or a `TIMEOUT` error needs a longer timeout, not a repeat at the same value.

## Results and retries

Actions report `data.disposition.delivery` and `retry`. Retry only when `retry` is `safe` (`not_delivered`). Any other delivery may have landed: read the live state with `get` or a snapshot, then decide. A repeated `type` or `click` can happen twice. Branch on `error.code`, not on the message.

## When the tree is not enough

Ref actions fail closed when an element has no usable accessibility path (`ACTION_NOT_SUPPORTED`, `POLICY_DENIED`, missing refs, Writer's document body, ambiguous or duplicate fields). Use the xdotool and screenshot fallback in the desktop-sandbox skill instead of guessing refs.
