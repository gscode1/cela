# 0066: Public view-only live view of a desktop session

Status: accepted, 2026-11-23 (issue #418). Builds on [0065](0065-desktop-sandbox.md) and replaces its "Lab live view" parts that
say the view is loopback only, needs no API or chart change and has nothing for gVisor, and its limit "no console live view".
Related: [0017](0017-schema-sharding.md) (shards), [0038](0038-network-modes.md), [0041](0041-browser-sandbox.md).

## Context

A person who starts a desktop session wants to watch it, from another machine, without a cluster login and without
`kubectl port-forward` (which does not work under gVisor). The requirement is deliberately simple: **public is public**. Anyone who
has the URL can watch, view-only, with no login. On the lab cluster "public" means the LAN, through Envoy Gateway.

## Decision

### Shape

```
viewer -> Envoy Gateway -> ingest /live/* -> owning orchestrator shard :8081 -> desktop Pod :6080 (websockify) -> x11vnc (loopback)
```

- It is optional and off twice: the chart's `liveView.enabled` (default false) and, per session, until the owner turns it on
  (`liveView: true` at create, `PUT /sessions/{id}/live-view`). `DELETE` turns it off.
- The URL is `<liveView.publicUrl>/live/<token>`. The token is `randomBytes(32)` in base64url, stored in plaintext in
  `inbox.sessions.live_view_token` (migration 040; the API must show it again). Null is off. `PUT` always mints a new one, which is
  the rotation; the old URL is a 404 at once. Deleting the session clears it; a Pod recycle or suspend keeps it. A unique partial
  index makes the lookup by token cheap.
- Only the session's owner sees the URL (create response, `GET /sessions/{id}`, `PUT`); the owner check is the existing one.
- An unknown, rotated and deleted token produce the same 404 with the same body.

### Ingest serves the page, the orchestrator is the data plane

- The viewer page (`viewer.html`, `viewer.js`) and the pinned `@novnc/novnc` modules are baked into the ingest image
  (`PI_LIVE_VIEW_DIR`) and served by ingest at `/live/_assets/*`. The sandbox Pod never supplies a byte of HTML or JavaScript: it is
  untrusted. The page has no inline script and a CSP with `connect-src 'self'`, `referrer-policy: no-referrer`, `x-robots-tag:
  noindex` and `cache-control: no-store`, so the token in the URL is not leaked or indexed.
- Ingest never talks to a sandbox (it has no Kubernetes access and its NetworkPolicy has no sandbox peer). For the WebSocket it
  looks the token up, then makes an upgrade request to the session's shard (`/live-view/<session id>`, header
  `x-live-view-token`) the way it already relays the SSE stream, and pipes the sockets only after a 101. Any other answer is replaced
  by a bare status line; 404, 429 and 503 keep their meaning for the page's retry logic.
- The orchestrator re-reads the session and compares the token in constant time. It requires the right shard, an active session
  and an existing conversation. **It never calls `ensureConversation`, resumes a suspended sandbox or touches the session's
  activity**: watching must not start or keep alive what the owner is not using. It resolves the Pod IP of the claim per connection
  (never stored, a recycled Pod has a new one) and connects to `GET /websockify` on port 6080, requires a 101 with the correct
  `Sec-WebSocket-Accept`, writes its own 101 (only the accept and the offered subprotocol) and pipes the sockets. No `ws`
  dependency: the byte stream is relayed with Node's `http` upgrade.
- Caps: `liveView.maxViewersPerSession` (default 4, `PI_LIVE_VIEW_MAX_VIEWERS`) and 32 per shard; one more is a 429. Every 5 s the
  orchestrator re-reads the token of the sessions with viewers and destroys the sockets whose token changed, was cleared or whose
  session is deleting, so a disable takes effect within about 5 s.

### View-only is enforced by the orchestrator

The viewer is anonymous and the Pod is untrusted, so view-only must not rest on x11vnc's `-viewonly` or on the page setting
`viewOnly = true`. The orchestrator filters what the viewer sends (`packages/orchestrator/src/rfb-filter.ts`):

- It parses the WebSocket frames from the viewer (masked, fragmentation allowed, control frames passed through, a 1 MiB frame limit, no
  extensions, text frames refused), unmasks them, and parses the RFB client messages in the reassembled byte stream. It re-frames and
  masks the allowed bytes as the Pod's WebSocket client.
- The handshake passes: ProtocolVersion must be 3.7 or 3.8, the security type the viewer chooses must be 1 (None), and the shared flag
  of ClientInit is forced to 1 (the viewer never disconnects the desktop's other clients). A server that offers only a type that needs
  an answer from the client cannot be completed, so the connection ends.
- After that only SetPixelFormat (0), SetEncodings (2) and FramebufferUpdateRequest (3) are forwarded. KeyEvent (4), PointerEvent (5)
  and ClientCutText (6, dropped with its text without buffering it) are dropped silently. **Any other message type ends the
  connection.**
- The framebuffer direction is relayed raw and never parsed.

x11vnc keeps `-viewonly` and the page sets `viewOnly = true`: both are defence in depth, not the control. A compromised Pod can still
send the viewer arbitrary framebuffer bytes (it controls the picture), which is inherent to showing a screen and is why the noVNC
client and the page come from ingest.

### Network and image

- `agent-desktop-run` binds websockify to `${PI_DESKTOP_LIVE_VIEW_LISTEN:-127.0.0.1}:6080` (only the value `0.0.0.0` widens it; anything else
  stays on loopback); x11vnc stays on loopback. The `pgrep` pattern no longer names the address, which otherwise restarted websockify on every
  call once it was not bound to 127.0.0.1. The wrapper also reads the variable from PID 1's environment when sandboxd does not hand the
  container's environment to the commands it runs.
- The chart sets `PI_DESKTOP_LIVE_VIEW_LISTEN=0.0.0.0` on the **desktop templates only, and only with `liveView.enabled`**; the claim's own
  env is fixed when the claim is created, the template's is not part of that. There is no secret in the Pod: the NetworkPolicy is the
  control (plan.md: the sandbox is the untrusted side). Only with `liveView.enabled` does the chart render
  `sandbox-allow-orchestrator-liveview-ingress` (pods `pi-sandbox` with `cela.dev/sandbox-flavour=desktop`, from `pi-orchestrator`, TCP 6080)
  and add 6080 to the orchestrator's egress to sandboxes. The ingest policy is unchanged and has no sandbox peer.
- An optional HTTPRoute `pi-live-view` carries `/live/` only, with `timeouts.request: "0s"`, so the anonymous surface can have its own
  hostname and policy. `cela.validate` refuses `liveView.enabled` without the desktop flavour and an http(s) `publicUrl` with no path,
  and the route without `networkPolicy.ingest.clients`.

### Departures from the rules the design had

- **Ingest's first unauthenticated dynamic route.** Until now ingest answered without a bearer only for the static console and the health
  probes. `/live/<token>` and the WebSocket look a secret up in Postgres. They run after the schema is ready, are GET/upgrade only, and
  every failure is the same 404.
- **The orchestrator is a data-plane hop** for viewer bytes, where before it carried only control and the SSE stream.
- **A second ingress port on sandboxes** (6080 beside sandboxd's 8080 and 9090), open to the orchestrator and only with the switch on.

## Limits and deferred

- A URL is a bearer secret: whoever has it can watch until it is rotated or turned off. There is no per-viewer identity, no audit of
  who watched, and no rate limit on `/live/*` beyond the viewer caps.
- Takeover (a person driving the desktop) stays deferred: it needs the filter to pass input and a different trust decision.
- The page shows nothing until the session's desktop exists (the first `agent-desktop-run` call starts it) and while a suspended session
  has no Pod; it retries with backoff.
- The desktop's content is untrusted and may show secrets the agent typed: the `desktop-sandbox` skill tells the agent so.
- Lab check still open: websockify bound to 0.0.0.0 under gVisor and the gateway's idle timeout for WebSocket upgrades.
