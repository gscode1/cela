## Findings

### 1. IPv6 NO_PROXY entries do not match IPv6 hosts
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/onecli.ts:118
- What happens: An entry such as `::1` is interpreted as pattern `:` with port `1`, while `[::1]` retains brackets that were removed from the URL hostname. Consequently, a model request to an IPv6 host configured for direct access is sent to the gateway instead, potentially failing if the gateway rejects private targets.
- Evidence: `const match = /^(.*):(\d+)$/.exec(entry);`
- Fix idea: Parse bracketed IPv6 addresses and optional ports explicitly, and treat unbracketed IPv6 literals as addresses rather than host-and-port pairs.

### 2. Redirects do not re-evaluate NO_PROXY
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/onecli.ts:163
- What happens: The proxy decision is made only for the initial URL. If a directly accessed host redirects to a public model host, fetch follows the redirect directly rather than through OneCLI; conversely, a proxied host redirecting to a NO_PROXY host remains proxied. Requests can therefore fail or bypass the intended gateway routing.
- Evidence: `if (bypassesProxy(url, config.noProxy)) return globalThis.fetch(input, init);`
- Fix idea: Make the routing decision for each redirect target, for example by handling redirects explicitly or using a dispatcher that selects the route per request.

END-OF-REPORT
