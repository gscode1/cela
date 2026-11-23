/* global document, location, setTimeout */
// The live view page: a view-only noVNC client. The page's own URL carries the token, so the WebSocket goes to the same
// path plus /ws. The script is served from ingest's image, never from the desktop Pod.
import RFB from "./novnc/core/rfb.js";

const screen = document.getElementById("screen");
const status = document.getElementById("status");
const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${location.pathname.replace(/\/$/, "")}/ws`;

let delay = 1000;

function say(text) {
  status.textContent = text;
}

function connect() {
  say("Connecting");
  const rfb = new RFB(screen, wsUrl);
  // Defence in depth: the orchestrator drops input messages whatever this page sends.
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", () => {
    delay = 1000;
    say("");
  });
  rfb.addEventListener("disconnect", () => {
    say("Disconnected, retrying");
    // Backoff up to 15 s: the desktop may be suspended, restarting or full of viewers.
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  });
}

connect();
