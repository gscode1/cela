# Example OneCLI network policies

Apply these in **your OneCLI namespace**, separately from the agent stack, using kubectl, Kustomize, Helm or your GitOps manager. They require Cilium CRDs and are not part of the charts.

- `ingress.yaml` admits orchestrators to the gateway (:10255) and management API (:10256), and sandboxes to the gateway only. It also admits e2e namespaces labelled `pi-durable-e2e=true` (see [e2e](../../docs/e2e.md)). Only trusted operators should be able to assign that label.
- The last ingress entry is an **optional Envoy Gateway example** for dashboard/API/proxy access. Replace its namespace and pod selectors for your ingress controller, or remove it and use port-forward. No public hostname or HTTPRoute is required. Protect dashboard and auth routes from untrusted clients.
- `egress.yaml` allows DNS, a database and HTTPS to the listed provider, GitHub, package and MCP hosts. It denies private, link-local and shared-address ranges as defence against DNS rebinding. Keep the FQDN list in step with [OneCLI host rules](../../docs/onecli-host-rules.md).

Before applying, patch `metadata.namespace`, the OneCLI pod label (`app=onecli`), the agent namespace (`pi-durable-poc`), DNS selectors, database namespace/cluster (`onecli`/`onecli-db` in this example), and ingress-controller selectors. Add Redis or other dependencies if your OneCLI installation uses them. The database example assumes CloudNativePG; use your database's actual selectors and ports.

```sh
kubectl kustomize hack/onecli-policies   # review first
kubectl apply -k hack/onecli-policies   # only after adapting to your installation
```

Start in policy audit mode, inspect Hubble for missing dependencies, then enforce and run the isolation and OneCLI suites. Check that the private CIDR denies do not override access to your database under your Cilium configuration. These examples do not install or configure OneCLI itself.
