# OneCLI network policies (for your Argo repo)

Status: merged into argo-c2 `applications/onecli` (#53, 2026-11-16) and enforced. This copy is the reference;
change argo-c2 first and keep this in step.

These two CiliumNetworkPolicies protect the `onecli` namespace. They are **not applied from this repository** and
they do not belong in it: `onecli` is managed by ArgoCD from the `argo-c2` repo, and Argo would revert anything applied
by hand. Copy `ingress.yaml` and `egress.yaml` (or this directory with its `kustomization.yaml`) into the OneCLI app
path of `argo-c2` and let Argo sync them.

- `ingress.yaml`: :10255 (gateway) from the pi-durable-poc orchestrator and sandboxes and from Envoy; :10256 (API) from
  the orchestrator and Envoy; :10254 (dashboard) from Envoy only. Envoy is there because HTTPRoute
  `onecli.example.com` is the only other client found on c2.
- `egress.yaml`: DNS to kube-dns, the onecli database on `postgres-clusters/pg-db-cluster`, and an FQDN allowlist on
  :443. Everything else, including cluster, LAN and node addresses, is denied.

Prerequisites and order (details in `docs/network-policy.md`):

1. Cilium is the CNI and `kubectl get crd ciliumnetworkpolicies.cilium.io` succeeds. Until then these manifests fail to
   sync in Argo (unknown kind).
2. The pi-durable-poc policies (`deploy/networkpolicy*.yaml`, `deploy/cilium/`) are applied first, so the orchestrator
   and sandboxes already have their egress allows when OneCLI starts denying anything else.
3. Put the OneCLI pod in policy audit mode first, read `hubble observe --verdict AUDIT`, then enforce. OneCLI may
   call hosts not on the list (UNVERIFIED); add them to `egress.yaml` and to the host rules (`docs/onecli-host-rules.md`).

Adding a host (for example an MCP server, `mcp.deepwiki.com`): change `egress.yaml` in the Argo repo first, then this
copy, then `deploy/onecli-host-rules.sh` (the three lists stay identical).

Rollback: delete the two policies in the Argo repo (a CiliumNetworkPolicy deletion restores allow-all for the pod).
