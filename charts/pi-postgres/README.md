# pi-postgres

A single Postgres 17 instance for cela ([install plan](../../docs/install-plan.md), D3). It is for evaluation:
one replica, no HA, no backups. Production points the app chart at an external Postgres instead.

It creates two databases, each owned by its own non-superuser role, and no other roles:

| Database | Role     | Used by                                         |
| -------- | -------- | ----------------------------------------------- |
| `pi`     | `pi`     | orchestrator and ingest                         |
| `onecli` | `onecli` | OneCLI (its own database, not a schema in `pi`) |

## Install

The Secrets are only referenced; this chart never creates or generates them (D8). Create them first, in the release
namespace:

```sh
kubectl -n <ns> create secret generic pi-postgres-auth \
  --from-literal=postgres-password="$(openssl rand -hex 24)" \
  --from-literal=pi-password="$(openssl rand -hex 24)" \
  --from-literal=onecli-password="$(openssl rand -hex 24)"
helm install pi-postgres charts/pi-postgres -n <ns>
```

The namespace should enforce the `restricted` Pod Security level; the Pod meets it (non-root uid 999, seccomp
`RuntimeDefault`, no capabilities, read-only root file system). The chart creates nothing cluster-scoped.

Clients connect to `pi-postgres.<ns>.svc:5432` (release name `pi-postgres`; `<release>` otherwise). The Pod is Ready
only after the databases and roles exist.

## Init of databases and roles

The image creates a database only on an empty data directory. A `init` sidecar in the same Pod therefore runs
[`files/init.sql`](files/init.sql) on **every** Pod start, so a new install, a restart and a reinstall onto a retained
volume all converge to the same state:

- roles and databases are created only when missing; attributes (`NOSUPERUSER` and so on), ownership and `CONNECT`
  grants (revoked from `PUBLIC`, so each role reaches only its own database) are re-applied;
- the role passwords are re-applied from the Secrets, so rotating a Secret and restarting the Pod rotates the role;
- passwords reach psql through environment variables (`\getenv`), never an argument, a manifest or the log, and the
  session turns off statement logging for its own statements.

The superuser password is set by the image only when it creates the data directory. Changing the Secret later does not
change it; do that with `ALTER ROLE postgres` yourself.

## TLS

Set `tls.existingSecret` to a Secret with the server certificate chain (`tls.crt`) and key (`tls.key`, keys configurable);
the chart never creates it. The server then runs `ssl=on`, and plain connections still work. `tls.requireTls=true` also
replaces `pg_hba.conf` so that remote clients must use TLS (`hostssl` only); the Pod-local socket used by the probes and the
init sidecar is unaffected. Keep it `false` while OneCLI's connection string does not ask for TLS. The certificate must
name the Service (`<release>.<ns>.svc`) for clients using `verify-full`; give them its CA through the app chart's
`database.tls` ([docs/database-tls.md](../../docs/database-tls.md)).

## Storage and uninstall

`persistence.retain: true` (default) sets `persistentVolumeClaimRetentionPolicy.whenDeleted: Retain`: the PVC survives
`helm uninstall` and a StatefulSet delete, and the next install with the same release name reuses the data. `false`
deletes the PVC with the StatefulSet. Delete a retained volume on purpose:
`kubectl -n <ns> delete pvc -l app.kubernetes.io/instance=<release>`.

## Network

Ingress to 5432 is admitted only from the Pods matching `networkPolicy.clientSelectors` (same namespace). Defaults:
the orchestrator, ingest and OneCLI. Add another client, for example an e2e client Pod, by appending its labels:

```sh
--set-json 'networkPolicy.clientSelectors=[{"app.kubernetes.io/name":"pi-orchestrator"},{"cela-e2e":"true"}]'
```

A list replaces the default, so repeat the entries you still need. The chart opens no egress.

## Values

See [`values.yaml`](values.yaml); [`values.schema.json`](values.schema.json) rejects unknown keys, a non-digest image
pin and empty Secret references. Render tests: `packages/orchestrator/test/charts.test.ts`.
