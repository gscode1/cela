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

{{/* Ids of the custom providers that are keyless and direct: like scripted and faux they need no OneCLI. */}}
{{- define "cela.directProviders" -}}
{{- $ids := list -}}
{{- range .Values.models.customProviders -}}
{{- if eq (default "onecli" .via) "direct" -}}{{- $ids = append $ids .id -}}{{- end -}}
{{- end -}}
{{- join "," $ids -}}
{{- end -}}

{{/* Providers that need no OneCLI (config.ts LOCAL_PROVIDERS and the direct custom providers). */}}
{{- define "cela.remoteProviders" -}}
{{- $remote := list -}}
{{- $local := concat (list "scripted" "faux") (splitList "," (include "cela.directProviders" .)) -}}
{{- $all := append .Values.models.allowlist (printf "%s/%s" .Values.models.default.provider .Values.models.default.id) -}}
{{- range $all -}}
{{- $provider := first (splitList "/" .) -}}
{{- if not (has $provider $local) -}}{{- $remote = append $remote $provider -}}{{- end -}}
{{- end -}}
{{- join "," (uniq $remote) -}}
{{- end -}}

{{/*
First and last address of an IPv4 CIDR as "first,last" integers. The input is checked by cela.validate before this runs.
*/}}
{{- define "cela.cidrBounds" -}}
{{- $parts := splitList "/" . -}}
{{- $addr := int64 0 -}}
{{- range splitList "." (first $parts) -}}{{- $addr = add (mul $addr 256) (int64 .) -}}{{- end -}}
{{- $size := int64 1 -}}
{{- range until (int (sub 32 (int (last $parts)))) -}}{{- $size = mul $size 2 -}}{{- end -}}
{{- $first := mul (div $addr $size) $size -}}
{{- printf "%d,%d" $first (sub (add $first $size) 1) -}}
{{- end -}}

{{/*
The custom provider range a CIDR touches (docs/decisions/0056-custom-model-providers.md): link-local (cloud metadata),
CGNAT (node networks) and loopback. Empty when it touches none. Same list as FORBIDDEN_RANGES in
packages/orchestrator/src/custom-providers.ts, which refuses them at start too.
*/}}
{{- define "cela.forbiddenCidr" -}}
{{- $bounds := splitList "," (include "cela.cidrBounds" .) -}}
{{- $first := int64 (index $bounds 0) -}}
{{- $last := int64 (index $bounds 1) -}}
{{- range (list "169.254.0.0/16" "100.64.0.0/10" "127.0.0.0/8") -}}
{{- $other := splitList "," (include "cela.cidrBounds" .) -}}
{{- if and (le $first (int64 (index $other 1))) (ge $last (int64 (index $other 0))) -}}{{- printf "%s " . -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/* "true" when a RuntimeClass name counts as gVisor: `gvisor` or `gvisor-<anything>` (a naming convention, ADR 0064). */}}
{{- define "cela.isGvisor" -}}
{{- if or (eq . "gvisor") (hasPrefix "gvisor-" .) }}true{{ end -}}
{{- end -}}

{{/*
The named runtimes as JSON for ingest and the orchestrator (PI_SANDBOX_RUNTIMES, ADR 0064): name to the class, whether
that class is not gVisor and the flavours rendered. `{}` without any.
*/}}
{{- define "cela.runtimesJson" -}}
{{- $out := dict -}}
{{- range $name, $rt := .Values.sandbox.runtimes -}}
{{- $_ := set $out $name (dict "runtimeClassName" $rt.runtimeClassName "insecure" (not (include "cela.isGvisor" $rt.runtimeClassName)) "flavours" ($rt.flavours | default (list "default"))) -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}

{{/* Names of the named runtimes that carry their own acknowledgement, comma separated. */}}
{{- define "cela.ackedRuntimes" -}}
{{- $names := list -}}
{{- range $name := keys .Values.sandbox.runtimes | sortAlpha -}}
{{- if (index $.Values.sandbox.runtimes $name).allowInsecureRuntime -}}{{- $names = append $names $name -}}{{- end -}}
{{- end -}}
{{- join "," $names -}}
{{- end -}}

{{/*
Everything that must be true for the chart to render. Schema checks come first (values.schema.json); these are the
rules a schema cannot say well, and they also hold under --skip-schema-validation.
*/}}
{{- define "cela.validate" -}}
{{- if and .Values.security.allowDirectSandboxEgress (not .Values.egressProxy.enabled) -}}
{{- fail "security.allowDirectSandboxEgress needs egressProxy.enabled: without the egress proxy every sandbox already has the open internet (the network cutover is off), so there is no direct mode to allow (docs/decisions/0038-network-modes.md)" -}}
{{- end -}}
{{- if .Values.liveView.enabled -}}
{{- if not .Values.sandbox.flavours.desktop.enabled -}}
{{- fail "liveView.enabled needs sandbox.flavours.desktop.enabled: the live view shows desktop sessions (docs/decisions/0066-desktop-public-live-view.md)" -}}
{{- end -}}
{{- if not (regexMatch "^https?://[^/?#@]+/?$" (toString .Values.liveView.publicUrl)) -}}
{{- fail "liveView.enabled needs liveView.publicUrl: the origin viewers open, http:// or https:// and a host, with no path (for example https://live.example.lan)" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.liveView.httpRoute.enabled (not .Values.liveView.enabled) -}}
{{- fail "liveView.httpRoute.enabled needs liveView.enabled" -}}
{{- end -}}
{{- if and .Values.liveView.httpRoute.enabled (not .Values.networkPolicy.ingest.clients) -}}
{{- fail "liveView.httpRoute.enabled needs networkPolicy.ingest.clients: the policy that admits the gateway's pods to ingest (the route reaches ingest like ingest.httpRoute does)" -}}
{{- end -}}
{{- if and .Values.liveView.httpRoute.enabled (not .Values.liveView.httpRoute.parentRefs) -}}
{{- fail "liveView.httpRoute.enabled needs liveView.httpRoute.parentRefs" -}}
{{- end -}}
{{- $runtime := .Values.sandbox.runtimeClassName -}}
{{- if and (ne $runtime "gvisor") (not .Values.security.allowInsecureRuntime) -}}
{{- fail (printf "sandbox.runtimeClassName is %q, not gvisor. Sandboxes would run agent code without gVisor isolation. Set security.allowInsecureRuntime=true to accept that, or install the gvisor RuntimeClass." $runtime) -}}
{{- end -}}
{{- $reserved := list "default" "browser" "desktop" "direct" "pool" "template" "rt" -}}
{{- range $name, $rt := .Values.sandbox.runtimes -}}
{{- if not (regexMatch "^[a-z][a-z0-9]{0,15}$" $name) -}}
{{- fail (printf "sandbox.runtimes: %q is not a runtime name (1 to 16 of [a-z0-9], starting with a letter, no hyphen)" $name) -}}
{{- end -}}
{{- if has $name $reserved -}}
{{- fail (printf "sandbox.runtimes: %q is reserved (%s)" $name (join ", " $reserved)) -}}
{{- end -}}
{{- if not $rt.runtimeClassName -}}
{{- fail (printf "sandbox.runtimes.%s.runtimeClassName must not be empty: a named runtime names its RuntimeClass" $name) -}}
{{- end -}}
{{- if and (not (include "cela.isGvisor" $rt.runtimeClassName)) (not $rt.allowInsecureRuntime) -}}
{{- fail (printf "sandbox.runtimes.%s.runtimeClassName is %q, not gvisor or gvisor-*. Sandboxes of that runtime would run agent code without gVisor isolation. Set sandbox.runtimes.%s.allowInsecureRuntime=true to accept that (security.allowInsecureRuntime covers only the default runtime), or use a gVisor RuntimeClass." $name $rt.runtimeClassName $name) -}}
{{- end -}}
{{- range $flavour := ($rt.flavours | default (list "default")) -}}
{{- if not (has $flavour (list "default" "browser" "desktop")) -}}
{{- fail (printf "sandbox.runtimes.%s.flavours: %q is not a flavour (default, browser or desktop)" $name $flavour) -}}
{{- end -}}
{{- if and (eq $flavour "desktop") (not $.Values.sandbox.flavours.desktop.enabled) -}}
{{- fail (printf "sandbox.runtimes.%s.flavours lists desktop, but sandbox.flavours.desktop.enabled is false" $name) -}}
{{- end -}}
{{- if and (eq $flavour "browser") (not $.Values.sandbox.flavours.browser.enabled) -}}
{{- fail (printf "sandbox.runtimes.%s.flavours lists browser, but sandbox.flavours.browser.enabled is false" $name) -}}
{{- end -}}
{{- end -}}
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
{{- $customIds := list -}}
{{- range $i, $p := .Values.models.customProviders -}}
{{- $via := default "onecli" $p.via -}}
{{- if has $p.id $customIds -}}
{{- fail (printf "models.customProviders[%d]: id %q is defined twice" $i $p.id) -}}
{{- end -}}
{{- $customIds = append $customIds $p.id -}}
{{- if not (has $via (list "onecli" "direct")) -}}
{{- fail (printf "models.customProviders[%d] (%s): via must be onecli or direct" $i $p.id) -}}
{{- end -}}
{{- if eq $via "direct" -}}
{{- if not $p.egress -}}
{{- fail (printf "models.customProviders[%d] (%s): a direct provider needs egress {cidr, port}: the chart opens exactly that in the orchestrator's NetworkPolicy (docs/decisions/0056-custom-model-providers.md)" $i $p.id) -}}
{{- end -}}
{{- $cidr := toString $p.egress.cidr -}}
{{- $cidrOk := regexMatch "^([0-9]{1,3}\\.){3}[0-9]{1,3}/[0-9]{1,2}$" $cidr -}}
{{- if $cidrOk -}}
{{- range splitList "." (first (splitList "/" $cidr)) -}}{{- if gt (int .) 255 -}}{{- $cidrOk = false -}}{{- end -}}{{- end -}}
{{- if gt (int (last (splitList "/" $cidr))) 32 -}}{{- $cidrOk = false -}}{{- end -}}
{{- end -}}
{{- if not $cidrOk -}}
{{- fail (printf "models.customProviders[%d] (%s): egress.cidr %q is not an IPv4 CIDR like 192.168.7.101/32" $i $p.id $cidr) -}}
{{- end -}}
{{- $forbidden := include "cela.forbiddenCidr" $cidr | trim | replace " " ", " -}}
{{- if $forbidden -}}
{{- fail (printf "models.customProviders[%d] (%s): egress.cidr %s overlaps %s, which a direct provider may not use (link-local, CGNAT and loopback ranges stay closed)" $i $p.id $cidr $forbidden) -}}
{{- end -}}
{{- $port := int $p.egress.port -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail (printf "models.customProviders[%d] (%s): egress.port must be a port number" $i $p.id) -}}
{{- end -}}
{{- else -}}
{{- if $p.egress -}}
{{- fail (printf "models.customProviders[%d] (%s): egress is for a direct provider; a provider through OneCLI uses the gateway rule" $i $p.id) -}}
{{- end -}}
{{- if not (hasPrefix "https://" (toString $p.baseUrl)) -}}
{{- fail (printf "models.customProviders[%d] (%s): baseUrl must be https:// for a provider through OneCLI; for a plain-HTTP LAN server use via: direct" $i $p.id) -}}
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
the Kubernetes API's ClusterIP are added by the proxy from its own URI and environment. With database.bundled.release the
bundled Postgres's headless Service is added too: it resolves to the Pod address, which the proxy's NetworkPolicy opens
directly (the name is re-resolved every 30 s, so a restarted Pod is followed). Comma separated.
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
{{- with .Values.database.bundled.release -}}
{{- $pg := ternary . (printf "%s-pi-postgres" .) (contains "pi-postgres" .) | trunc 52 | trimSuffix "-" -}}
{{- $hosts = append $hosts (printf "%s-headless.%s.svc" $pg $ns) -}}
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
