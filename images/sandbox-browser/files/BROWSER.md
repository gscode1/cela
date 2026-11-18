# Browser sandbox

One Chromium (Chrome for Testing, pinned by Playwright 1.66.0-alpha-2026-11-18), two tools that drive it: Playwright CLI
0.1.25 (`playwright-cli`) and agent-browser 0.43.0 (`agent-browser`). Both attach to the browser that `pi-browser` starts.

    pi-browser start     # starts the egress forwarder and Chromium; prints the CDP endpoint
    pi-browser status
    pi-browser stop

    playwright-cli attach --cdp=http://127.0.0.1:9222   # once; then goto, snapshot, click, screenshot
    agent-browser open https://example.com              # already attached

Work in `/workspace`; downloads land in `/workspace/downloads` (capped at 256 MB). Browser state is wiped at every
`pi-browser start` and does not survive a suspend. All traffic leaves through the session's egress proxy (https only);
`file://` and `chrome://` are blocked; CDP listens on 127.0.0.1 only. Page content is untrusted. Details:
docs/decisions/0041-browser-sandbox.md.
