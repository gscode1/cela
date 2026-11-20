{{/*
Object names are fixed on purpose (see values.yaml): policies, e2e suites and ingest's routing select on them.
*/}}

{{- define "cela.labels" -}}
app.kubernetes.io/part-of: cela
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* image reference: repository[:tag][@digest]; takes (dict "name" "orchestrator" "image" .Values.images.orchestrator) */}}
{{- define "cela.image" -}}
{{- $ref := required (printf "images.%s.repository is required" .name) .image.repository -}}
{{- if not (or .image.tag .image.digest) -}}
{{- fail (printf "images.%s: set a tag or a digest (images/build.sh prints them; CI publishes them)" .name) -}}
{{- end -}}
{{- if .image.tag -}}{{- $ref = printf "%s:%s" $ref .image.tag -}}{{- end -}}
{{- if .image.digest -}}{{- $ref = printf "%s@%s" $ref .image.digest -}}{{- end -}}
{{- $ref -}}
{{- end -}}

{{/* The port of an http(s) URL: explicit, else 443 for https and 80 for http. Host names only (no IPv6 literals). */}}
{{- define "cela.urlPort" -}}
{{- $u := urlParse . -}}
{{- if contains ":" $u.host -}}{{- last (splitList ":" $u.host) -}}
{{- else if eq $u.scheme "https" -}}443
{{- else -}}80
{{- end -}}
{{- end -}}

{{- define "cela.onecliEnabled" -}}
{{- if ne .Values.onecli.mode "disabled" -}}true{{- end -}}
{{- end -}}

{{/*
The OneCLI settings the other templates use, as JSON (read it with `include ... | fromJson`): the `external` values as
they are, or, for the bundled release (hack/onecli.sh, same namespace), the names that release and its bootstrap
produce. One place, so the two modes cannot drift apart.
*/}}
{{- define "cela.onecli" -}}
{{- if eq .Values.onecli.mode "bundled" -}}
{{- $b := .Values.onecli.bundled -}}
{{- $ns := .Release.Namespace -}}
{{- dict "apiUrl" (printf "http://%s-api.%s.svc:10256" $b.release $ns) "gatewayUrl" (printf "http://%s-gateway.%s.svc:10255" $b.release $ns) "caConfigMap" $b.caConfigMap "agentTokenSecret" $b.agentTokenSecret "adminKeySecret" $b.adminKeySecret "namespace" $ns "podSelector" (dict "app.kubernetes.io/name" "onecli" "app.kubernetes.io/instance" $b.release) | toJson -}}
{{- else -}}
{{- toJson .Values.onecli.external -}}
{{- end -}}
{{- end -}}

{{/* Providers that need no OneCLI (config.ts LOCAL_PROVIDERS). */}}
{{- define "cela.remoteProviders" -}}
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
{{- define "cela.validate" -}}
{{- if and .Values.security.allowDirectSandboxEgress (not .Values.egressProxy.enabled) -}}
{{- fail "security.allowDirectSandboxEgress needs egressProxy.enabled: without the egress proxy every sandbox already has the open internet (the network cutover is off), so there is no direct mode to allow (docs/decisions/0038-network-modes.md)" -}}
{{- end -}}
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
{{- $remote := include "cela.remoteProviders" . -}}
{{- if $remote -}}
{{- fail (printf "onecli.mode is disabled but models name the provider(s) %s, which need the OneCLI gateway. Use scripted models only, or set onecli.mode=external." $remote) -}}
{{- end -}}
{{- else -}}
{{- fail (printf "onecli.mode %q is not supported yet (bundled, external or disabled)" .Values.onecli.mode) -}}
{{- end -}}
{{- if .Values.egressProxy.enabled -}}
{{- if not .Values.egressProxy.database.existingSecret -}}
{{- fail "egressProxy.enabled (the default) needs egressProxy.database.existingSecret: a Secret with the connection URI of the proxy's read-only role pi_egress (docs/network-policy.md, docs/decisions/0035-egress-proxy-runtime.md; hack/install.sh creates it from EGRESS_DATABASE_URL). To run without the proxy, set egressProxy.enabled=false: sandboxes then reach the internet directly, unfiltered (docs/decisions/0038-network-modes.md)" -}}
{{- end -}}
{{- if and (ne .Values.onecli.mode "disabled") (not .Values.egressProxy.binding.existingSecret) -}}
{{- fail "egressProxy.enabled (the default) with OneCLI needs egressProxy.binding.existingSecret: a Secret with a 32 byte base64 key under `key`, which seals the OneCLI tokens the proxy chains (docs/decisions/0037-egress-onecli-route.md; hack/install.sh creates it). Or set egressProxy.enabled=false to run without the proxy" -}}
{{- end -}}
{{- if not (or .Values.images.egressProxy.tag .Values.images.egressProxy.digest) -}}
{{- fail "egressProxy.enabled (the default) needs images.egressProxy.tag or digest, like the other images (CI publishes ghcr.io/gscode1/pi-egress-proxy with the same tag; images/build.sh egress-proxy prints them)" -}}
{{- end -}}
{{- range $i, $p := .Values.egressProxy.privateEgress -}}
{{- $hasCidr := not (empty $p.cidr) -}}
{{- $hasSelector := or (hasKey $p "namespaceSelector") (hasKey $p "podSelector") -}}
{{- if and (not $hasCidr) (not $hasSelector) -}}
{{- fail (printf "egressProxy.privateEgress[%d] needs a cidr, or a namespaceSelector (with an optional podSelector)" $i) -}}
{{- end -}}
{{- if and $hasCidr $hasSelector -}}
{{- fail (printf "egressProxy.privateEgress[%d]: use either a cidr or selectors, not both" $i) -}}
{{- end -}}
{{- if not $p.ports -}}
{{- fail (printf "egressProxy.privateEgress[%d] needs ports: private destinations are opened per port" $i) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.networkPolicy.provider (list "cilium" "standard")) -}}
{{- fail "networkPolicy.provider must be cilium or standard" -}}
{{- end -}}
{{- if and (or .Values.ingest.httpRoute.enabled .Values.ingest.ingress.enabled) (not .Values.networkPolicy.ingest.clients) -}}
{{- fail "ingest.httpRoute or ingest.ingress is on but networkPolicy.ingest.clients is empty: default-deny-all would drop the gateway's traffic. Admit its pods there (values.yaml has an Envoy Gateway example)." -}}
{{- end -}}
{{- end -}}

{{/*
Names the egress proxy resolves and blocks as "the platform" (ADR 0035): the namespace's own Services (ingest, every
orchestrator shard, the OneCLI API and gateway when in the cluster) and the kubernetes Service. The database host and
the Kubernetes API's ClusterIP are added by the proxy from its own URI and environment. Comma separated.
*/}}
{{- define "cela.egressPlatformHosts" -}}
{{- $ns := .Release.Namespace -}}
{{- $hosts := list (printf "pi-ingest.%s.svc" $ns) "kubernetes.default.svc" -}}
{{- range $shard := until (int .Values.orchestrator.shards) -}}
{{- $hosts = append $hosts (printf "%s.%s.svc" (ternary "pi-orchestrator" (printf "pi-orchestrator-%d" $shard) (eq $shard 0)) $ns) -}}
{{- end -}}
{{- if ne .Values.onecli.mode "disabled" -}}
{{- $o := include "cela.onecli" . | fromJson -}}
{{- range (list $o.apiUrl $o.gatewayUrl) -}}
{{- $hosts = append $hosts (first (splitList ":" (urlParse .).host)) -}}
{{- end -}}
{{- end -}}
{{- concat $hosts .Values.egressProxy.platform.hosts | uniq | join "," -}}
{{- end -}}

{{/* The OneCLI route of the egress proxy (ADR 0037) exists when the proxy and OneCLI are both on. */}}
{{- define "cela.egressOnecliRoute" -}}
{{- if and .Values.egressProxy.enabled (ne .Values.onecli.mode "disabled") }}true{{ end -}}
{{- end }}

{{/* host:port of the OneCLI gateway, the one upstream of the proxy. */}}
{{- define "cela.onecliGatewayAddr" -}}
{{- $o := include "cela.onecli" . | fromJson -}}
{{- printf "%s:%s" (first (splitList ":" (urlParse $o.gatewayUrl).host)) (include "cela.urlPort" $o.gatewayUrl) -}}
{{- end }}

{{/* Addresses the egress proxy blocks as the platform: the operator's cidrs, the API server addresses and the database's cidrs. */}}
{{- define "cela.egressPlatformCidrs" -}}
{{- concat .Values.egressProxy.platform.cidrs .Values.networkPolicy.kubeApiCidrs .Values.database.external.egress.cidrs | uniq | join "," -}}
{{- end -}}

{{/* A restricted container-level security context (ADR 0019); the Pod sets user, group and seccomp. */}}
{{- define "cela.containerSecurityContext" -}}
allowPrivilegeEscalation: false
privileged: false
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "cela.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* NetworkPolicy `to` entries for the database (pod selector and/or CIDRs). */}}
{{- define "cela.databaseTo" -}}
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
{{- define "cela.onecliTo" -}}
{{- $o := include "cela.onecli" . | fromJson -}}
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
{{- define "cela.databaseTlsEnabled" -}}
{{- /* verify-full with the system roots and no client cert needs no files, so no volume. */}}
{{- if and (ne .Values.database.tls.mode "disable") (or .Values.database.tls.caKey .Values.database.tls.certKey) }}true{{ end -}}
{{- end }}

{{- define "cela.databaseTlsEnv" -}}
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

{{- define "cela.databaseTlsMount" -}}
- { name: database-tls, mountPath: /etc/pi-database-tls, readOnly: true }
{{- end }}

{{- define "cela.databaseTlsVolume" -}}
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

{{/*
The network cutover (ADR 0038): with the egress proxy on, a sandbox reaches the proxy and nothing else, unless its Pod
carries cela.dev/network-mode=direct (only possible with security.allowDirectSandboxEgress). Without the proxy the
sandbox policies are the ones from before the cutover.
*/}}
{{- define "cela.networkCutover" -}}
{{- if .Values.egressProxy.enabled }}true{{ end -}}
{{- end -}}

{{/* Where a direct sandbox may connect: the public internet minus every address that is ours (ADR 0038). */}}
{{- define "cela.sandboxInternetTo" -}}
- ipBlock:
    cidr: 0.0.0.0/0
    except:
      {{- range (list "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" "127.0.0.0/8") }}
      - {{ . }}
      {{- end }}
      {{- range .Values.networkPolicy.sandbox.extraEgressExcept }}
      {{- if not (contains ":" .) }}
      - {{ . | quote }}
      {{- end }}
      {{- end }}
- ipBlock:
    cidr: "::/0"
    except:
      {{- range (list "fc00::/7" "fe80::/10" "::1/128") }}
      - {{ . | quote }}
      {{- end }}
      {{- range .Values.networkPolicy.sandbox.extraEgressExcept }}
      {{- if contains ":" . }}
      - {{ . | quote }}
      {{- end }}
      {{- end }}
{{- end -}}
