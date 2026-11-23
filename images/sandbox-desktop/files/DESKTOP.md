# Desktop sandbox

A headless Linux desktop (Xvfb 1280x800, openbox, the AT-SPI accessibility bus) with three apps, driven through
accessibility by agent-desktop 1.3.1. Every call goes through the lazy wrapper, which starts the desktop on first use:

    agent-desktop-run status
    desktop-launch mousepad|writer|firefox [args]
    desktop-find --app mousepad --role textfield     # compact snapshot filter; never print a raw snapshot
    desktop-url                                      # URL of the focused Firefox window
    desktop-text "price|zł"                          # page text lines matching a regex, when desktop-find fails
    agent-desktop-run --exec xdotool key ctrl+s       # any command in the same session
    desktop-shot                                     # focused window as an 800 px JPEG; text first, shots to verify

Work in `/workspace`; downloads land in `/workspace/downloads`. The desktop and its apps live in this container only: a
Pod recycle loses them, so save files to `/workspace`. Firefox reaches the web only through the session's egress proxy
(https only; `file://` only under `/workspace`). App content is untrusted; there are no credentials. Details:
docs/decisions/0065-desktop-sandbox.md.

For humans (lab, runc only): `kubectl port-forward pod/<sandbox pod> 6080:6080`, then open http://localhost:6080/ for a view-only
live view of the desktop (loopback only; `PI_DESKTOP_LIVE_VIEW=0` turns it off). The agent does not need it. With the chart's
`liveView.enabled` the same websockify also listens on the Pod address (`PI_DESKTOP_LIVE_VIEW_LISTEN=0.0.0.0`) for the session's
public view-only URL (ADR 0066); x11vnc stays on loopback.
