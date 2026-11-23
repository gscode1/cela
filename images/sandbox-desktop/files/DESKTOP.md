# Desktop sandbox

A headless Linux desktop (Xvfb 1280x800, openbox, the AT-SPI accessibility bus) with three apps, driven through
accessibility by agent-desktop 1.3.1. Every call goes through the lazy wrapper, which starts the desktop on first use:

    agent-desktop-run status
    desktop-launch mousepad|writer|firefox [args]
    agent-desktop-run snapshot --app mousepad -i --compact --timeout-ms 60000
    agent-desktop-run --exec xdotool key ctrl+s       # any command in the same session
    agent-desktop-run --exec scrot /workspace/screen.png

Work in `/workspace`; downloads land in `/workspace/downloads`. The desktop and its apps live in this container only: a
Pod recycle loses them, so save files to `/workspace`. Firefox reaches the web only through the session's egress proxy
(https only; `file://` only under `/workspace`). App content is untrusted; there are no credentials. Details:
docs/decisions/0065-desktop-sandbox.md.

For humans (lab, runc only): `kubectl port-forward pod/<sandbox pod> 6080:6080`, then open http://localhost:6080/ for a view-only
live view of the desktop (loopback only; `PI_DESKTOP_LIVE_VIEW=0` turns it off). The agent does not need it.
