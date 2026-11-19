#!/usr/bin/env python3
"""Helm values (JSON, which is YAML) for the pi-durable chart in one e2e run: tests/e2e/run.sh passes them with -f.

The run's own charts/pi-postgres release is the external database (secret `pi-db-uri`, made by run.sh),
the shared OneCLI is external, and the test switches of the orchestrator are extra environment. Everything that varies
per run comes from the environment (the image and storage-class variables of docs/e2e.md) or the two arguments.

DB_TLS=1 makes the orchestrator and ingest verify the database server (database.tls verify-full against the CA in
the Secret `pi-db-tls-ca`, which run.sh makes); the URI's host is a name in the server certificate.

usage: chart-values.py <onecli name prefix> <shards>
"""
import json
import os
import sys


def split_ref(ref: str) -> dict:
    """repo[:tag][@digest] -> the chart's {repository, tag, digest}. A colon in the first path part is a port."""
    digest = ""
    if "@" in ref:
        ref, digest = ref.split("@", 1)
    tag = ""
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        ref, tag = ref.rsplit(":", 1)
    if not tag and not digest:
        raise SystemExit(f"image reference without a tag or a digest: {ref}")
    return {"repository": ref, "tag": tag, "digest": digest}


def main() -> None:
    prefix, shards = sys.argv[1], int(sys.argv[2])
    storage_class = os.environ.get("STORAGE_CLASS", "")
    # Workspaces are per-session scratch, so they may use their own (for example single-replica) class.
    workspace_class = os.environ.get("SANDBOX_STORAGE_CLASS") or storage_class
    values = {
        "images": {
            "orchestrator": split_ref(os.environ["ORCH_IMAGE"]),
            "ingest": split_ref(os.environ["INGEST_IMAGE"]),
            "sandbox": split_ref(os.environ["SANDBOX_IMAGE"]),
        },
        "database": {
            "external": {
                "existingSecret": "pi-db-uri",  # made by run.sh from the pi-postgres secrets
                "uriKey": "uri",
                "egress": {"podSelector": {"app.kubernetes.io/name": "pi-postgres"}},
            }
        },
        "onecli": {
            "mode": "external",
            # The OneCLI workspace is shared with every other stack: each run names its agents with its own prefix (ADR 0013).
            "namePrefix": prefix,
            "external": {
                "apiUrl": "http://onecli.onecli:10256",
                "gatewayUrl": "http://onecli.onecli:10255",
                "caConfigMap": "onecli-ca",
                "agentTokenSecret": "pi-onecli",
                "adminKeySecret": "pi-onecli-admin",
            },
        },
        # Only REPO_A: phase4c's sessions clone it, REPO_B is the repository its token must not reach (ADR 0032).
        "github": {
            "app": {"existingSecret": "pi-github-app"},
            "repoAllowlist": [os.environ["REPO_A"]] if os.environ.get("REPO_A") else [],
        },
        "sandbox": {"storageClass": workspace_class},
        "networkPolicy": {
            "provider": "cilium",
            # The driver Job calls ingest directly; its other policies are in tests/e2e/deploy.
            "ingest": {"clients": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "e2e-driver"}}}]},
        },
        "api": {"admins": ["alice"]},
        "models": {
            # The suites use the scripted models and set them as the default through the admin API; the real ones are
            # for phase4b with REAL_MODEL=1.
            "default": {"provider": "openai-codex", "id": "gpt-6.1-terra", "reasoning": "medium"},
            "allowlist": [
                "openai-codex/gpt-6.1-terra",
                "openai-codex/gpt-6.1-sol",
                "scripted/scripted-1",
                "scripted/scripted-2",
            ],
        },
        "orchestrator": {
            "shards": shards,
            # The cluster is small: requests are lowered, limits stay as in production.
            "resources": {
                "requests": {"cpu": "50m", "memory": "192Mi"},
                "limits": {"cpu": "1", "memory": "2Gi"},
            },
            "extraEnv": [
                # CONTROL mounts the authenticated scripted-session surface under /control; TEST_FAULTS honours
                # payload.testFault on inbox rows, which only SQL can write, so phase4 can kill the orchestrator
                # between submit and mark.
                {"name": "PI_ORCH_CONTROL", "value": "1"},
                {"name": "PI_ORCH_TEST_FAULTS", "value": "1"},
                # Short sweep and suspend settings, so the lifecycle tests take minutes, not hours. Bridges are evicted
                # after 30 s idle (ADR 0016) and sandboxes are suspended after 120 s, an age other tests never idle for.
                {"name": "PI_SANDBOX_IDLE_EVICT_SECONDS", "value": "30"},
                {"name": "PI_SWEEP_INTERVAL_SECONDS", "value": "15"},
                {"name": "PI_SWEEP_GRACE_SECONDS", "value": "45"},
                {"name": "PI_SANDBOX_IDLE_SUSPEND_SECONDS", "value": "120"},
            ],
        },
        "ingest": {"replicas": 2},
        # Only the console suite turns the admin console on (tests/e2e/run.sh console).
        "console": {"enabled": os.environ.get("CONSOLE_ENABLED") == "1"},
        # The chart turns the egress proxy on by default (ADR 0038, amendment of 2026-11-19). Only the browser suite runs
        # with it (below); the other suites opt out, as they did before the default changed, so they keep testing what
        # they were written for (direct sandbox egress, the OneCLI gateway reached from the sandbox).
        "egressProxy": {"enabled": False},
    }
    if os.environ.get("BROWSER_SUITE") == "1":
        # The browser suite (run-browser.sh, ADR 0041): the egress proxy (its Secrets are made by run.sh), the browser
        # flavour on the chart's default runtime (gVisor), and the live model it drives.
        values["images"]["sandboxBrowser"] = split_ref(os.environ["BROWSER_SANDBOX_IMAGE"])
        values["images"]["egressProxy"] = split_ref(os.environ["EGRESS_PROXY_IMAGE"])
        values["egressProxy"] = {
            "enabled": True,
            "database": {"existingSecret": "pi-egress-database", "uriKey": "uri"},
            "binding": {"existingSecret": "pi-egress-binding", "key": "key"},
        }
        values["sandbox"]["flavours"] = {"browser": {"enabled": True}}
        values["models"]["allowlist"].append("openai-codex/gpt-6-luna")
    if os.environ.get("DB_TLS") == "1":
        values["database"]["tls"] = {"mode": "verify-full", "existingSecret": "pi-db-tls-ca", "caKey": "ca.crt"}
    json.dump(values, sys.stdout, indent=2)
    print()


main()
