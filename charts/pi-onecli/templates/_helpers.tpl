{{- define "pi-onecli.labels" -}}
app.kubernetes.io/part-of: cela
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}
