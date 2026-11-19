# Example OneCLI network policies

Apply these in **your OneCLI namespace**, separately from the agent stack, using kubectl, Kustomize, Helm or your GitOps manager. They require Cilium CRDs and are not part of the charts.

- `ingress.yaml` admits orchestrators to the gateway (:10255) and management API (:10256), and sandboxes to the gateway only. It also admits e2e namespaces labelled `pi-durable-e2e=true` (see [e2e](../../docs/e2e.md)). Only trusted operators should be able to assign that label.
- The last ingress entry is an **optional Envoy Gateway example** for dashboard/API/proxy access. Replace its namespace and pod selectors for your ingress controller, or remove it and use port-forward. No public hostname or HTTPRoute is required. Protect dashboard and auth routes from untrusted clients.
- `egress.yaml` (the open default, [ADR 0043](../../docs/decisions/0043-open-onecli-defaults.md)) allows DNS, a database and TCP 443 to anything outside the cluster (`toEntities: [world]`, so a LAN MCP server works). It denies link-local (cloud metadata) and shared-address (CGNAT) ranges outright. Set the gateway's `allowPrivateDestinations` too, or OneCLI itself refuses private addresses.
- **In-cluster LoadBalancer targets.** If an MCP server's hostname resolves to a LoadBalancer IP served by this same cluster (an Envoy Gateway or ingress), Cilium translates the IP to the backend pod, so the destination is that pod, not `world`, and the `world` rule drops it. Uncomment the example `toEndpoints` rule at the end of `egress.yaml`: select the gateway pods (namespace and labels) and the pod's target port (for example 10443 for Envoy Gateway's 443 listener, not 443), so only the HTTPS listener is admitted.
- `egress-strict.yaml` is the hardening variant: the FQDN allowlist of the provider, GitHub, package and MCP hosts, plus the full private-range deny as defence against DNS rebinding. It is not in `kustomization.yaml`. It has the same policy name as `egress.yaml`, so applying one replaces the other and never both run. Keep its list in step with [OneCLI host rules](../../docs/onecli-host-rules.md) (a unit test compares them).

Before applying, patch `metadata.namespace`, the OneCLI pod label (`app=onecli`), the agent namespace (`pi-durable-poc`), DNS selectors, database namespace/cluster (`onecli`/`onecli-db` in this example), and ingress-controller selectors. Add Redis or other dependencies if your OneCLI installation uses them. The database example assumes CloudNativePG; use your database's actual selectors and ports.

```sh
kubectl kustomize hack/onecli-policies   # review first
kubectl apply -k hack/onecli-policies   # only after adapting to your installation
```

Start in policy audit mode, inspect Hubble for missing dependencies, then enforce and run the isolation and OneCLI suites. With the strict variant, check that the private CIDR denies do not override access to your database under your Cilium configuration. These examples do not install or configure OneCLI itself.
