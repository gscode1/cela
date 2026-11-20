# 0050: Opt-in MCP adapter admin mode

Status: accepted (issue #321). Amends ADR 0031's prohibition on admin tools.

The local adapter can optionally expose admin API tools, using a separate admin bearer token. Admin mode is off by default; enabling it exposes reads only. Profile writes require a second explicit flag. All writes go through ingest and require an expected revision, including create-only revision 0. Ingest remains the authorization and concurrency boundary; there is no database access. The existing session token and session tools are unchanged. Requests reject redirects and tokens must never appear in results or logs.

An agent with access to this process can read deployment configuration; with writes enabled it can change or delete profiles. A shell-capable agent can also read its environment, so only grant admin mode to trusted clients. Other admin writes and session profile rendering are deferred.
