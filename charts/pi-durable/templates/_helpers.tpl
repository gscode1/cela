{{/*
Object names are fixed on purpose (see values.yaml): policies, e2e suites and ingest's routing select on them.
*/}}

{{- define "pi-durable.labels" -}}
app.kubernetes.io/part-of: pi-durable
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* image reference: repository[:tag][@digest]; takes (dict "name" "orchestrator" "image" .Values.images.orchestrator) */}}
{{- define "pi-durable.image" -}}
{{- $ref := required (printf "images.%s.repository is required" .name) .image.repository -}}
{{- if not (or .image.tag .image.digest) -}}
{{- fail (printf "images.%s: set a tag or a digest (images/build.sh prints them; CI publishes them)" .name) -}}
{{- end -}}
{{- if .image.tag -}}{{- $ref = printf "%s:%s" $ref .image.tag -}}{{- end -}}
{{- if .image.digest -}}{{- $ref = printf "%s@%s" $ref .image.digest -}}{{- end -}}
{{- $ref -}}
{{- end -}}

{{/* The port of an http(s) URL: explicit, else 443 for https and 80 for http. Host names only (no IPv6 literals). */}}
{{- define "pi-durable.urlPort" -}}
{{- $u := urlParse . -}}
{{- if contains ":" $u.host -}}{{- last (splitList ":" $u.host) -}}
{{- else if eq $u.scheme "https" -}}443
{{- else -}}80
{{- end -}}
{{- end -}}

{{- define "pi-durable.onecliEnabled" -}}
{{- if ne .Values.onecli.mode "disabled" -}}true{{- end -}}
{{- end -}}

{{/*
The OneCLI settings the other templates use, as JSON (read it with `include ... | fromJson`): the `external` values as
they are, or, for the bundled release (hack/onecli.sh, same namespace), the names that release and its bootstrap
produce. One place, so the two modes cannot drift apart.
*/}}
{{- define "pi-durable.onecli" -}}
{{- if eq .Values.onecli.mode "bundled" -}}
{{- $b := .Values.onecli.bundled -}}
{{- $ns := .Release.Namespace -}}
{{- dict "apiUrl" (printf "http://%s-api.%s.svc:10256" $b.release $ns) "gatewayUrl" (printf "http://%s-gateway.%s.svc:10255" $b.release $ns) "caConfigMap" $b.caConfigMap "agentTokenSecret" $b.agentTokenSecret "adminKeySecret" $b.adminKeySecret "namespace" $ns "podSelector" (dict "app.kubernetes.io/name" "onecli" "app.kubernetes.io/instance" $b.release) | toJson -}}
{{- else -}}
{{- toJson .Values.onecli.external -}}
{{- end -}}
{{- end -}}

{{/* Providers that need no OneCLI (config.ts LOCAL_PROVIDERS). */}}
{{- define "pi-durable.remoteProviders" -}}
{{- $remote := list -}}
{{- $all := append .Values.models.allowlist (printf "%s/%s" .Values.models.default.provider .Values.models.default.id) -}}
{{- range $all -}}
{{- $provider := first (splitList "/" .) -}}
{{- if not (has $provider (list "scripted" "faux")) -}}{{- $remote = append $remote $provider -}}{{- end -}}
{{- end -}}
{{- join "," (uniq $remote) -}}
{{- end -}}

{{/*
Everything that must be true for the chart to render. Schema checks come first (values.schema.json); these are the
rules a schema cannot say well, and they also hold under --skip-schema-validation.
*/}}
{{- define "pi-durable.validate" -}}
{{- $runtime := .Values.sandbox.runtimeClassName -}}
{{- if and (ne $runtime "gvisor") (not .Values.security.allowInsecureRuntime) -}}
{{- fail (printf "sandbox.runtimeClassName is %q, not gvisor. Sandboxes would run agent code without gVisor isolation. Set security.allowInsecureRuntime=true to accept that, or install the gvisor RuntimeClass." $runtime) -}}
{{- end -}}
{{- if ne .Values.agentSandbox.mode "external" -}}
{{- fail "agentSandbox.mode must be external: install or check the controller with hack/agent-sandbox.sh (bundled mode comes in a later slice)" -}}
{{- end -}}
{{- if not (hasKey .Values.sandbox.sizes .Values.sandbox.defaultSize) -}}
{{- fail (printf "sandbox.defaultSize %q is not one of sandbox.sizes (%s)" .Values.sandbox.defaultSize (keys .Values.sandbox.sizes | sortAlpha | join ", ")) -}}
{{- end -}}
{{- range $name, $_ := .Values.sandbox.sizes -}}
{{- if not (regexMatch "^[a-z][a-z0-9-]{0,15}$" $name) -}}
{{- fail (printf "sandbox.sizes: %q is not a size name (1 to 16 of [a-z0-9-], starting with a letter)" $name) -}}
{{- end -}}
{{- end -}}
{{- $db := .Values.database.external -}}
{{- if not $db.existingSecret -}}
{{- fail "database.external.existingSecret is required: a Secret in the release namespace holding the Postgres connection URI" -}}
{{- end -}}
{{- if not (or $db.egress.podSelector $db.egress.cidrs) -}}
{{- fail "database.external.egress needs a podSelector or cidrs: with default-deny-all the orchestrator and ingest cannot reach the database otherwise" -}}
{{- end -}}
{{- if eq .Values.onecli.mode "external" -}}
{{- if not (and .Values.onecli.external.apiUrl .Values.onecli.external.gatewayUrl) -}}
{{- fail "onecli.mode is external: set onecli.external.apiUrl and onecli.external.gatewayUrl" -}}
{{- end -}}
{{- else if eq .Values.onecli.mode "bundled" -}}
{{- if not (and .Values.onecli.bundled.release .Values.onecli.bundled.caConfigMap .Values.onecli.bundled.agentTokenSecret .Values.onecli.bundled.adminKeySecret) -}}
{{- fail "onecli.mode is bundled: onecli.bundled needs release, caConfigMap, agentTokenSecret and adminKeySecret" -}}
{{- end -}}
{{- else if eq .Values.onecli.mode "disabled" -}}
{{- $remote := include "pi-durable.remoteProviders" . -}}
{{- if $remote -}}
{{- fail (printf "onecli.mode is disabled but models name the provider(s) %s, which need the OneCLI gateway. Use scripted models only, or set onecli.mode=external." $remote) -}}
{{- end -}}
{{- else -}}
{{- fail (printf "onecli.mode %q is not supported yet (bundled, external or disabled)" .Values.onecli.mode) -}}
{{- end -}}
{{- if not (has .Values.networkPolicy.provider (list "cilium" "standard")) -}}
{{- fail "networkPolicy.provider must be cilium or standard" -}}
{{- end -}}
{{- if and (or .Values.ingest.httpRoute.enabled .Values.ingest.ingress.enabled) (not .Values.networkPolicy.ingest.clients) -}}
{{- fail "ingest.httpRoute or ingest.ingress is on but networkPolicy.ingest.clients is empty: default-deny-all would drop the gateway's traffic. Admit its pods there (values.yaml has an Envoy Gateway example)." -}}
{{- end -}}
{{- end -}}

{{/* A restricted container-level security context (ADR 0019); the Pod sets user, group and seccomp. */}}
{{- define "pi-durable.containerSecurityContext" -}}
allowPrivilegeEscalation: false
privileged: false
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "pi-durable.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* NetworkPolicy `to` entries for the database (pod selector and/or CIDRs). */}}
{{- define "pi-durable.databaseTo" -}}
{{- $e := .Values.database.external.egress -}}
{{- if $e.podSelector }}
- podSelector:
    matchLabels:
      {{- toYaml $e.podSelector | nindent 6 }}
{{- if $e.namespace }}
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ $e.namespace }}
{{- end }}
{{- end }}
{{- range $e.cidrs }}
- ipBlock:
    cidr: {{ . }}
{{- end }}
{{- end -}}

{{/* NetworkPolicy `to` entry for the OneCLI pods. */}}
{{- define "pi-durable.onecliTo" -}}
{{- $o := include "pi-durable.onecli" . | fromJson -}}
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ $o.namespace }}
  podSelector:
    matchLabels:
      {{- toYaml $o.podSelector | nindent 6 }}
{{- end -}}

{{/*
Database TLS (database.tls). The Secret is mounted read-only at /etc/pi-database-tls and only the keys that are used are
projected, so a client key in a shared Secret is not mounted when mTLS is off. Without `optional` a missing Secret keeps
the pod from starting, which is wanted: a pod that cannot verify the server must not start.
*/}}
{{- define "pi-durable.databaseTlsEnabled" -}}
{{- /* verify-full with the system roots and no client cert needs no files, so no volume. */}}
{{- if and (ne .Values.database.tls.mode "disable") (or .Values.database.tls.caKey .Values.database.tls.certKey) }}true{{ end -}}
{{- end }}

{{- define "pi-durable.databaseTlsEnv" -}}
{{- $tls := .Values.database.tls }}
{{- /* disable sets nothing: the URI keeps its own sslmode, as before this value existed. */}}
{{- if ne $tls.mode "disable" }}
- { name: PI_DURABLE_DATABASE_TLS_MODE, value: {{ $tls.mode | quote }} }
{{- if $tls.caKey }}
- { name: PI_DURABLE_DATABASE_TLS_CA_FILE, value: /etc/pi-database-tls/ca.crt }
{{- end }}
{{- if $tls.certKey }}
- { name: PI_DURABLE_DATABASE_TLS_CERT_FILE, value: /etc/pi-database-tls/tls.crt }
- { name: PI_DURABLE_DATABASE_TLS_KEY_FILE, value: /etc/pi-database-tls/tls.key }
{{- end }}
{{- end }}
{{- end }}

{{- define "pi-durable.databaseTlsMount" -}}
- { name: database-tls, mountPath: /etc/pi-database-tls, readOnly: true }
{{- end }}

{{- define "pi-durable.databaseTlsVolume" -}}
- name: database-tls
  secret:
    secretName: {{ .Values.database.tls.existingSecret }}
    defaultMode: 288 # 0440, in decimal so no YAML parser reads it as 440
    items:
      {{- if .Values.database.tls.caKey }}
      - { key: {{ .Values.database.tls.caKey }}, path: ca.crt }
      {{- end }}
      {{- if .Values.database.tls.certKey }}
      - { key: {{ .Values.database.tls.certKey }}, path: tls.crt }
      - { key: {{ .Values.database.tls.keyKey }}, path: tls.key }
      {{- end }}
{{- end }}
