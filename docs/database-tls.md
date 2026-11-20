# Database TLS

The orchestrator and ingest connect to Postgres with TLS that always verifies the server ([ADR 0021](decisions/0021-database-tls.md)).

## Environment (both services)

| Variable                              | Meaning                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PI_DURABLE_DATABASE_TLS_MODE`        | unset (the URI decides, as before), `disable`, `verify-ca` or `verify-full`. Anything else fails the start |
| `PI_DURABLE_DATABASE_TLS_CA_FILE`     | PEM file of the CA that signed the server certificate. Required for `verify-ca`; `verify-full` without it uses the system roots |
| `PI_DURABLE_DATABASE_TLS_CERT_FILE`, `..._KEY_FILE` | client certificate and key (mutual TLS), both or neither                                  |

`verify-full` checks chain and host name; `verify-ca` checks the chain only. There is no `require`: encrypting without
verifying protects only against passive listeners.

The egress proxy (`packages/egress-proxy`, [ADR 0035](decisions/0035-egress-proxy-runtime.md)) reads the same three
variables, with the same rules: unset leaves the URI in charge, `verify-ca` **requires** the CA file (`PI_DURABLE_DATABASE_TLS_CA_FILE is
required when PI_DURABLE_DATABASE_TLS_MODE is verify-ca`, and the proxy does not start), only `verify-full` may use the
system roots, the client certificate and key come together. The proxy's URI is its own (the read-only role); the chart
sets the variables from `database.tls` and mounts the same Secret.

## Precedence with the URI

- Mode unset: the URI is used as is (`sslmode` there, then `PGSSLMODE`).
- Mode set: the variables decide. `sslmode` in the URI must equal the mode (it is then removed) or the start fails;
  `sslrootcert`, `sslcert`, `sslkey` in the URI fail the start. `PGSSLMODE` is ignored.

Errors name the variable and the file (for example a CA file that is not mounted), never the URI.

## Chart

`charts/cela` value `database.tls`: `mode`, `existingSecret` (a Secret in the release namespace), `caKey`
(default `ca.crt`), `certKey` and `keyKey` (optional mutual TLS). The Secret is mounted read-only at
`/etc/pi-database-tls` in both Deployments, only the keys that are used. With mode `disable` (default) nothing is
set or mounted. `charts/pi-postgres` serves TLS with `tls.existingSecret` (and only TLS from outside the Pod with
`tls.requireTls`). The server certificate must name the Service for `verify-full`.

```sh
kubectl -n <ns> create secret generic pi-database-ca --from-file=ca.crt=ca.crt
helm upgrade cela charts/cela -n <ns> --reuse-values \
  --set database.tls.mode=verify-full --set database.tls.existingSecret=pi-database-ca
```
