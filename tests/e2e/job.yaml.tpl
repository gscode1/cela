# Template for the driver Job; tests/e2e/run.sh fills __JOB__, __PHASE__, __IMAGE__, __ONLY__ and __REAL_MODEL__ (1 = also the real-model test of phase4b, which spends model turns) (the tests to run; empty = all of the phase).
# The image is public and pinned by digest (multi-arch index, includes linux/arm64): bash, curl, jq, openssl, kubectl.
# The Job talks to the API server with its ServiceAccount (in-cluster config); no kubeconfig, no context.
apiVersion: batch/v1
kind: Job
metadata:
  name: __JOB__
  labels:
    app.kubernetes.io/name: e2e-driver
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 3600
  ttlSecondsAfterFinished: 900
  template:
    metadata:
      labels:
        app.kubernetes.io/name: e2e-driver
    spec:
      serviceAccountName: e2e-driver
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: driver
          image: __IMAGE__
          command: [bash, /driver/tests/e2e/run-__PHASE__.sh]
          env:
            - { name: HOME, value: /tmp }
            - { name: KUBE_CONTEXT, value: "" }
            - { name: NO_COLOR, value: "1" }
            - { name: ONLY, value: "__ONLY__" }
            - { name: REAL_MODEL, value: "__REAL_MODEL__" }
            - { name: REPO_A, value: "__REPO_A__" }
            - { name: REPO_B, value: "__REPO_B__" }
            # The orchestrator's OneCLI name prefix in this run (docs/e2e.md): the suites look up agents by it.
            - { name: PI_ONECLI_NAME_PREFIX, value: "__ONECLI_NAME_PREFIX__" }
            - name: NAMESPACE
              valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { cpu: "1", memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          volumeMounts:
            - { name: driver, mountPath: /driver, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: driver
          persistentVolumeClaim:
            claimName: e2e-driver
            readOnly: true
        - name: tmp
          emptyDir: {}
