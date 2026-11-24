// Every click on a button or link is written into #log as text: "clicked: <id> at x,y" (CSS px in the page's own
// viewport). The suite reads it back with `desktop-web text`, so nothing is injected into the page by the driver.
// Links never navigate: the log line is the outcome. Shadow roots are reached through composedPath.
document.addEventListener(
  "click",
  (e) => {
    const t = e.composedPath().find((n) => n.tagName === "BUTTON" || n.tagName === "A");
    if (!t) return;
    e.preventDefault();
    const log = document.getElementById("log");
    log.textContent += `${log.textContent ? "\n" : ""}clicked: ${t.id || t.textContent.trim()} at ${Math.round(e.clientX)},${Math.round(e.clientY)}`;
  },
  true,
);
