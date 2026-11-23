import { DEFAULT_SANDBOX_RUNTIME } from "@cela/session-core";
import type { SandboxRuntimes } from "@cela/session-core";
import { configuredRuntime, listTemplateRuntimes } from "./kube.js";
import type { TemplateRuntime } from "./kube.js";

type Warn = (event: string, fields: Record<string, unknown>) => void;

/** Check the actual pool/template, not a duplicate env value that a manifest edit could bypass. */
export function guardRuntime(runtime: string, allow: string | undefined, warn: Warn): void {
  if (runtime === "gvisor") return;
  if (allow !== "1") {
    throw new Error(
      `Sandbox runtime ${JSON.stringify(runtime)} is not gvisor; set PI_ALLOW_INSECURE_RUNTIME=1 to explicitly allow an insecure runtime`,
    );
  }
  warn("INSECURE-SANDBOX-RUNTIME", {
    level: "warn",
    configuredRuntime: runtime,
    message: "Sandbox runtime isolation is NOT provided by gVisor",
  });
}

/** gVisor is a naming convention (ADR 0064): the RuntimeClass `gvisor` or `gvisor-<anything>`. */
export const isGvisorClass = (runtimeClassName: string): boolean =>
  runtimeClassName === "gvisor" || runtimeClassName.startsWith("gvisor-");

export interface RuntimeGuardInput {
  templates: readonly TemplateRuntime[];
  /** `PI_SANDBOX_RUNTIMES`. */
  named: SandboxRuntimes;
  /** `PI_ALLOW_INSECURE_RUNTIME`: covers the default runtime only. */
  allowDefault: string | undefined;
  /** `PI_ALLOW_INSECURE_RUNTIMES`: the named runtimes whose entry acknowledges an insecure class. */
  allowNamed: readonly string[];
}

/**
 * Guards every runtime the chart rendered templates for: templates are grouped by their runtime label and each group
 * must have one class. The default group (a template without the label, from a chart older than ADR 0064, counts as
 * default) follows the single-runtime rule; a named group must be one `PI_SANDBOX_RUNTIMES` knows, with that class, and
 * a class that is not gVisor needs its own acknowledgement. Returns the class each named runtime really runs under.
 */
export function guardRuntimes(input: RuntimeGuardInput, warn: Warn): Record<string, string> {
  const groups = new Map<string, Map<string, string[]>>();
  for (const template of input.templates) {
    const runtime = template.runtime ?? DEFAULT_SANDBOX_RUNTIME;
    const classes = groups.get(runtime) ?? new Map<string, string[]>();
    classes.set(template.runtimeClassName, [
      ...(classes.get(template.runtimeClassName) ?? []),
      template.name,
    ]);
    groups.set(runtime, classes);
  }
  const named: Record<string, string> = {};
  for (const [runtime, classes] of groups) {
    if (classes.size > 1) {
      const detail = [...classes].map(
        ([cls, names]) => `${JSON.stringify(cls)} (${names.join(", ")})`,
      );
      throw new Error(
        `Sandbox runtime ${JSON.stringify(runtime)} has templates with different RuntimeClasses: ${detail.join("; ")}`,
      );
    }
    const [runtimeClassName] = [...classes.keys()];
    if (runtimeClassName === undefined) continue;
    if (runtime === DEFAULT_SANDBOX_RUNTIME) {
      guardRuntime(runtimeClassName, input.allowDefault, warn);
      continue;
    }
    const entry = Object.hasOwn(input.named, runtime) ? input.named[runtime] : undefined;
    if (entry === undefined) {
      throw new Error(
        `SandboxTemplates are labelled with sandbox runtime ${JSON.stringify(runtime)}, which PI_SANDBOX_RUNTIMES does not define (chart key sandbox.runtimes.${runtime})`,
      );
    }
    if (entry.runtimeClassName !== runtimeClassName) {
      throw new Error(
        `Sandbox runtime ${JSON.stringify(runtime)}: its templates use RuntimeClass ${JSON.stringify(runtimeClassName)} but PI_SANDBOX_RUNTIMES says ${JSON.stringify(entry.runtimeClassName)}`,
      );
    }
    if (!isGvisorClass(runtimeClassName)) {
      if (!input.allowNamed.includes(runtime)) {
        throw new Error(
          `Sandbox runtime ${JSON.stringify(runtime)} uses RuntimeClass ${JSON.stringify(runtimeClassName)}, which is not gvisor or gvisor-*; set sandbox.runtimes.${runtime}.allowInsecureRuntime=true (PI_ALLOW_INSECURE_RUNTIMES) to explicitly allow an insecure runtime`,
        );
      }
      warn("INSECURE-SANDBOX-RUNTIME", {
        level: "warn",
        sandboxRuntime: runtime,
        configuredRuntime: runtimeClassName,
        message: "Sandbox runtime isolation is NOT provided by gVisor",
      });
    }
    named[runtime] = runtimeClassName;
  }
  return named;
}

/**
 * The default runtime's class (from the pool the orchestrator uses), after guarding it and every named runtime. The
 * named runtimes' classes come back too, for the status row.
 */
export async function checkRuntime(
  namespace: string,
  warmPool: string,
  named: SandboxRuntimes,
  allowNamed: readonly string[],
): Promise<{ runtime: string; named: Record<string, string> }> {
  const warn: Warn = (event, fields) => console.warn(JSON.stringify({ event, ...fields }));
  const runtime = await configuredRuntime(namespace, warmPool);
  guardRuntime(runtime, process.env.PI_ALLOW_INSECURE_RUNTIME, warn);
  const guarded = guardRuntimes(
    {
      templates: await listTemplateRuntimes(namespace),
      named,
      allowDefault: process.env.PI_ALLOW_INSECURE_RUNTIME,
      allowNamed,
    },
    // The default group was just warned about above.
    (event, fields) => {
      if (fields.sandboxRuntime !== undefined) warn(event, fields);
    },
  );
  return { runtime, named: guarded };
}
