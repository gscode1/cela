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
{{- if eq .Values.onecli.mode "external" -}}true{{- end -}}
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
{{- else if eq .Values.onecli.mode "disabled" -}}
{{- $remote := include "pi-durable.remoteProviders" . -}}
{{- if $remote -}}
{{- fail (printf "onecli.mode is disabled but models name the provider(s) %s, which need the OneCLI gateway. Use scripted models only, or set onecli.mode=external." $remote) -}}
{{- end -}}
{{- else -}}
{{- fail (printf "onecli.mode %q is not supported yet (external or disabled; bundled arrives with install slice 10)" .Values.onecli.mode) -}}
{{- end -}}
{{- if not (has .Values.networkPolicy.provider (list "cilium" "standard")) -}}
{{- fail "networkPolicy.provider must be cilium or standard" -}}
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
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ .Values.onecli.external.namespace }}
  podSelector:
    matchLabels:
      {{- toYaml .Values.onecli.external.podSelector | nindent 6 }}
{{- end -}}
