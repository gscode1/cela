/* global process, fetch, console, TextDecoder, setTimeout */
// One process that follows several sessions' SSE streams (runs inside an ingest pod, reads the owner's token from
// PI_API_TOKENS, never prints it). Args: owner then <label>=<sessionId>[@lastId] ...
// Prints "<label> ENTRY <id> <json>", "<label> DONE" when an assistant entry contains END-OF-REPORT, "<label> END <why>".
const [owner, ...specs] = process.argv.slice(2);
const token = (process.env.PI_API_TOKENS ?? "")
  .split(/[\n,]/)
  .map((l) => l.split(":"))
  .find(([o]) => o === owner)
  ?.slice(1)
  .join(":");
if (!token) throw new Error("no token");
const base = "http://127.0.0.1:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function follow(label, id, lastId) {
  for (;;) {
    try {
      const res = await fetch(`${base}/sessions/${id}/stream`, {
        headers: {
          authorization: `Bearer ${token}`,
          ...(lastId ? { "last-event-id": String(lastId) } : {}),
        },
      });
      if (res.status !== 200) {
        console.log(`${label} END status=${res.status}`);
        await sleep(5000);
        continue;
      }
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const eid = /^id: (.*)$/m.exec(block)?.[1];
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (ev !== "entry") continue;
          lastId = eid;
          console.log(`${label} ENTRY ${eid} ${data}`);
          const msgs = JSON.parse(data).messages ?? [];
          if (
            msgs.some((m) => m.role === "assistant" && (m.text ?? "").includes("END-OF-REPORT"))
          ) {
            console.log(`${label} DONE`);
            return;
          }
        }
      }
      console.log(`${label} END closed last=${lastId ?? 0}`);
    } catch (e) {
      console.log(`${label} END error=${String(e.message).slice(0, 80)} last=${lastId ?? 0}`);
    }
    await sleep(3000);
  }
}
await Promise.all(
  specs.map((s) => {
    const [label, rest] = s.split("=");
    const [id, last] = rest.split("@");
    return follow(label, id, last);
  }),
);
