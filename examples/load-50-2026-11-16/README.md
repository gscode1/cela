# Historical experiment scripts

Results and measurements from this dated run are in [lab notes](../../docs/lab-notes.md#load-50-2026-11-16),
from one example environment, not a deployment guide. Prompts, reports and verification notes here are historical.
Raw transcripts and failed-start logs have been dropped; scripts create a new `raw/` directory when run.

Use [tests/e2e](../../docs/e2e.md) for routine testing. These scripts spend real model turns and may change repository
branches. If reusing them, set `REPO=owner/repo`, `NAMESPACE` (default `pi-durable-poc`) and optionally
`KUBE_CONTEXT` (default current context), and review prompts and model names first. Use a dedicated test cluster.
