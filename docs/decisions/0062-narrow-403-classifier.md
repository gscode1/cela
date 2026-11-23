# 0062: A 403 fails the session only when it names the credentials

Status: accepted, 2026-11-23 (issue #379). Narrows the rejected-credentials rule in `failure.ts` (`terminalFailure`).

## Context

`terminalFailure` treated any model error with a standalone `403`, `forbidden` or `permission denied` as rejected
credentials and set the session to the terminal status `failed`. Providers also use 403 for refusals of one request:
OpenRouter moderation ("Your chosen model requires moderation and your input was flagged"), "Country, region, or
territory not supported", Google `PERMISSION_DENIED` for a location. One flagged message then killed the session with a
misleading reason. Custom providers (ADR 0056) make this more likely.

pi-ai keeps the SDK's message, which the OpenAI and Anthropic SDKs build as `<status> <body message>` (`403 <message>`,
or `403 status code (no body)`). So the body wording is available to tell the cases apart. The exact OpenRouter
moderation text was not captured from a live run; the patterns below do not depend on it.

## Decision

A model error is terminal when its text has:

- a standalone `401` or `407` (provider rejecting the key, gateway rejecting the agent token), `unauthorized`,
  `access_restricted` / `does not have access` (OneCLI's no-grant answer), or proxy authentication wording; or
- credential wording: invalid, incorrect, expired or revoked API key, credentials or token, `authentication failed`,
  `authentication error`, `authentication required`.

A 403 therefore ends the session only with such wording ("403 Invalid API key"). A bare `403`, `forbidden` or
`permission denied`, and 403s about moderation, policy or region, leave the session active; the next message starts a
new run. The failure message is unchanged and still never echoes the provider's text.

## Consequences

- A real revoked key that a provider reports as a bare `403 Forbidden` no longer fails the session; the user sees the
  model error in the transcript and each new message repeats the call. OneCLI's own revocation answers (401, 407,
  `access_restricted`) are unaffected.
- Adding a provider whose auth failures use other wording means adding a pattern and a test case.
