# Pi 1.5.2 storage, killed mid-tool-call

JSONL storage written by Pi Durable 1.5.2 (`pi.tool` version 3, `pi.generation` version 2), as of cela commit 050103c
with `@gscode1/pi-durable-postgres` 0.3.0 and the orchestrator's `Host`. Conversation 2 holds one input, `r1`,
scripted as one `hold` tool call and then the answer `ok`. The writing process was killed with SIGKILL while `hold` was
running, so the tool task is open and the input unsettled, as after an orchestrator pod kill.

Used by `test/pi-upgrade-resume.test.ts`. Do not regenerate it with a newer Pi: the point is that an older Harness wrote it.
To regenerate, check out 050103c, build the orchestrator, and run a child process that opens
`openNodeJsonlStorage(dir)` under `Host.open` with a `hold` tool that never returns, creates a `scripted-1` conversation,
submits `{"steps":[{"tool":"hold","args":{}}],"final":"ok"}` as `r1`, and kill it with SIGKILL once `hold` has started.
