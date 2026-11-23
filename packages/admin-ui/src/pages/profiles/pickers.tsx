import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { RuleSetSummary } from "@/lib/api/egress";
import type {
  McpServerRef,
  NetworkMode,
  NetworkModeCatalog,
  SandboxFlavour,
  SandboxFlavourCatalog,
  SandboxRuntimeCatalog,
  SandboxSize,
  SandboxSizeCatalog,
  SkillInfo,
  SkillPin,
} from "@/lib/api/profiles";
import { fieldLabel } from "@/lib/field-labels";
import { hostOf } from "@/lib/profile-form";
import { toolDescription } from "@/lib/tool-descriptions";

/** Marks what has no egress rule and no audit (ADR 0038): a profile or session with `networkMode: direct`. */
export function UnfilteredBadge() {
  return (
    <Badge variant="warning" title="No egress rule applies and nothing is audited">
      unfiltered, unaudited
    </Badge>
  );
}

export function Fieldset({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

/** CPU and memory limits and the workspace of a size, for a picker row. */
export function sizeSummary(size: SandboxSize): string {
  const cpu = size.limits.cpu ?? "?";
  const memory = size.limits.memory ?? "?";
  return `${cpu} CPU, ${memory} memory, ${size.workspaceSize} workspace`;
}

/**
 * The profile's sandbox: size (docs/decisions/0030-sandbox-sizes.md), network mode (ADR 0038) and image flavour (ADR
 * 0041). When the deployment offers one choice for each and the profile uses the default, there is nothing to pick and
 * one muted line says what the sandbox is. Otherwise one row of three selects, so a value the profile already has stays
 * visible. Sizes are the deployment's (chart values); one that is no longer defined stays visible with a way to drop it,
 * since the API refuses to store it again. `direct`, `browser` and `desktop` are disabled while the chart does not allow them, and a
 * profile that already says so keeps showing it.
 */
export function SandboxPicker({
  size,
  allowedSizes,
  sizeCatalog,
  mode,
  modeCatalog,
  flavour,
  flavourCatalog,
  runtime,
  runtimeCatalog,
  onChange,
}: {
  size: string;
  allowedSizes: string[];
  sizeCatalog: SandboxSizeCatalog | undefined;
  mode: NetworkMode;
  modeCatalog: NetworkModeCatalog | undefined;
  flavour: SandboxFlavour;
  flavourCatalog: SandboxFlavourCatalog | undefined;
  /** Empty for the default runtime. */
  runtime: string;
  runtimeCatalog: SandboxRuntimeCatalog | undefined;
  onChange: (
    change:
      | { sandboxSize: string }
      | { sandboxSizes: string[] }
      | { networkMode: NetworkMode }
      | { sandboxFlavour: SandboxFlavour }
      | { sandboxRuntime: string },
  ) => void;
}) {
  const sizes = sizeCatalog?.sizes ?? [];
  const defined = (name: string): boolean => sizes.some((entry) => entry.name === name);
  const directAllowed = modeCatalog?.directAllowed === true;
  const browserEnabled = flavourCatalog?.browserEnabled === true;
  const desktopEnabled = flavourCatalog?.desktopEnabled === true;
  const runtimes = runtimeCatalog?.runtimes ?? [];
  const nothingToPick =
    sizeCatalog !== undefined &&
    modeCatalog !== undefined &&
    flavourCatalog !== undefined &&
    runtimeCatalog !== undefined &&
    runtimes.length === 0 &&
    runtime === "" &&
    sizes.length <= 1 &&
    size === "" &&
    allowedSizes.length === 0 &&
    !directAllowed &&
    mode === "proxied" &&
    !browserEnabled &&
    !desktopEnabled &&
    flavour === "default";
  if (nothingToPick) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="sandbox-default">
        Sandbox: default size, proxied network, default image.
      </p>
    );
  }
  const effective = size === "" ? (sizeCatalog?.defaultSize ?? "") : size;
  return (
    <Fieldset legend="Sandbox">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-sandbox-size">{fieldLabel("sandboxSize")}</Label>
          <Select
            id="profile-sandbox-size"
            value={size}
            onChange={(event) => {
              onChange({ sandboxSize: event.target.value });
            }}
          >
            <option value="">
              Inherit (global default
              {sizeCatalog?.defaultSize ? `: ${sizeCatalog.defaultSize}` : ""})
            </option>
            {sizes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}: {sizeSummary(entry)}
              </option>
            ))}
            {size !== "" && sizeCatalog !== undefined && !defined(size) && (
              <option value={size}>{size} (not defined)</option>
            )}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-network-mode">{fieldLabel("networkMode")}</Label>
          <Select
            id="profile-network-mode"
            value={mode}
            onChange={(event) => {
              onChange({ networkMode: event.target.value === "direct" ? "direct" : "proxied" });
            }}
          >
            <option value="proxied">Proxied: under the egress rules (default)</option>
            <option
              value="direct"
              disabled={!directAllowed && mode !== "direct"}
              {...(directAllowed ? {} : { title: "Not allowed in this deployment" })}
            >
              Direct: open internet, unfiltered
              {directAllowed ? "" : " (not allowed)"}
            </option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-sandbox-flavour">{fieldLabel("sandboxFlavour")}</Label>
          <Select
            id="profile-sandbox-flavour"
            value={flavour}
            onChange={(event) => {
              onChange({
                sandboxFlavour:
                  event.target.value === "browser" || event.target.value === "desktop"
                    ? event.target.value
                    : "default",
              });
            }}
          >
            <option value="default">Default: shell and files (default)</option>
            <option
              value="browser"
              disabled={!browserEnabled && flavour !== "browser"}
              {...(browserEnabled ? {} : { title: "Not enabled in this deployment" })}
            >
              Browser: Chromium and agent-browser
              {browserEnabled ? "" : " (not enabled)"}
            </option>
            <option
              value="desktop"
              disabled={!desktopEnabled && flavour !== "desktop"}
              {...(desktopEnabled ? {} : { title: "Not enabled in this deployment" })}
            >
              Desktop: virtual desktop, Firefox, LibreOffice and agent-desktop
              {desktopEnabled ? "" : " (not enabled)"}
            </option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-sandbox-runtime">{fieldLabel("sandboxRuntime")}</Label>
          <Select
            id="profile-sandbox-runtime"
            value={runtime}
            onChange={(event) => {
              onChange({ sandboxRuntime: event.target.value });
            }}
          >
            <option value="">Default runtime</option>
            {runtimes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
                {entry.insecure ? " (not gVisor)" : ""}
              </option>
            ))}
            {runtime !== "" &&
              runtimeCatalog !== undefined &&
              !runtimes.some((entry) => entry.name === runtime) && (
                <option value={runtime}>{runtime} (not defined)</option>
              )}
          </Select>
        </div>
      </div>
      {runtime !== "" && mode === "direct" && (
        <p className="text-sm text-destructive" data-testid="runtime-direct-note">
          A named runtime is proxied only: it cannot be combined with the direct network mode.
        </p>
      )}
      {mode === "direct" && (
        <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="direct-warning">
          <UnfilteredBadge /> No egress rule applies and nothing is audited. Not combinable with
          repositories, credentialed MCP servers or rule sets with a OneCLI route.
        </p>
      )}
      {(flavour === "browser" || flavour === "desktop") && (
        <p className="text-sm text-muted-foreground" data-testid={`${flavour}-note`}>
          Pair it with the proxied network mode and an egress rule set that allows the sites. Not
          combinable with repositories, credentialed MCP servers or rule sets with a OneCLI route.
        </p>
      )}
      {sizes.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{fieldLabel("sandboxSizes")}</p>
          {sizes
            .filter((entry) => entry.name !== effective)
            .map((entry) => (
              <div key={entry.name} className="flex flex-wrap items-center gap-2 text-sm">
                <Checkbox
                  id={`size-${entry.name}`}
                  checked={allowedSizes.includes(entry.name)}
                  onChange={(event) => {
                    onChange({
                      sandboxSizes: event.target.checked
                        ? [...allowedSizes, entry.name]
                        : allowedSizes.filter((name) => name !== entry.name),
                    });
                  }}
                />
                <Label htmlFor={`size-${entry.name}`}>{entry.name}</Label>
                <span className="text-muted-foreground">{sizeSummary(entry)}</span>
              </div>
            ))}
        </div>
      )}
      {sizeCatalog !== undefined &&
        allowedSizes
          .filter((name) => !defined(name))
          .map((name) => (
            <div
              key={name}
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="missing-size"
            >
              <Badge variant="destructive">not defined</Badge>
              <span className="font-mono">{name}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onChange({ sandboxSizes: allowedSizes.filter((entry) => entry !== name) });
                }}
              >
                Remove {name}
              </Button>
            </div>
          ))}
    </Fieldset>
  );
}

/**
 * A tool list, with the difference the API keeps: "all" is an omitted field, a selection is an explicit list, and an
 * empty selection means no tools at all.
 */
export function ToolList({
  idPrefix,
  legend,
  all,
  selected,
  offered,
  installed,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  all: boolean;
  selected: string[];
  /** The tools that may be picked: the installed ones, narrowed for `modelTools` by the enabled tools. */
  offered: readonly string[];
  installed: readonly string[];
  onChange: (all: boolean, selected: string[]) => void;
}) {
  const unknown = selected.filter((name) => !installed.includes(name));
  return (
    <Fieldset legend={legend}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-all`}
          checked={all}
          onChange={(event) => {
            onChange(event.target.checked, event.target.checked ? [] : [...offered]);
          }}
        />
        <Label htmlFor={`${idPrefix}-all`}>All tools (default)</Label>
      </div>
      {!all && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {offered.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-${name}`}
                checked={selected.includes(name)}
                onChange={(event) => {
                  onChange(
                    false,
                    event.target.checked
                      ? [...selected, name]
                      : selected.filter((entry) => entry !== name),
                  );
                }}
              />
              <Label htmlFor={`${idPrefix}-${name}`}>{name}</Label>
              {toolDescription(name) !== undefined && (
                <span className="text-xs text-muted-foreground">{toolDescription(name)}</span>
              )}
            </div>
          ))}
          {selected.length === 0 && <p className="text-sm">No tools.</p>}
        </div>
      )}
      {unknown.map((name) => (
        <div
          key={name}
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="unknown-tool"
        >
          <Badge variant="destructive">removed tool</Badge>
          <span className="font-mono break-all">{name}</span>
          <span className="text-muted-foreground">
            This tool is no longer installed, so a new version cannot list it.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onChange(
                false,
                selected.filter((entry) => entry !== name),
              );
            }}
          >
            Remove {name}
          </Button>
        </div>
      ))}
    </Fieldset>
  );
}

export function McpPicker({
  selected,
  catalog,
  onChange,
}: {
  selected: string[];
  catalog: McpServerRef[] | undefined;
  onChange: (selected: string[]) => void;
}) {
  const missing =
    catalog === undefined ? [] : selected.filter((name) => !catalog.some((s) => s.name === name));
  const empty = catalog?.length === 0;
  return (
    <Fieldset
      legend={fieldLabel("mcpServers")}
      {...(empty ? {} : { hint: "Their tools become available to the model." })}
    >
      {empty && (
        <p className="text-sm text-muted-foreground">
          No MCP servers registered.{" "}
          <Link className="underline underline-offset-4" to="/mcp">
            Register one
          </Link>
        </p>
      )}
      {(catalog ?? []).map((server) => (
        <div key={server.name} className="flex flex-wrap items-center gap-2 text-sm">
          <Checkbox
            id={`mcp-${server.name}`}
            checked={selected.includes(server.name)}
            onChange={(event) => {
              onChange(
                event.target.checked
                  ? [...selected, server.name]
                  : selected.filter((entry) => entry !== server.name),
              );
            }}
          />
          <Label htmlFor={`mcp-${server.name}`}>{server.name}</Label>
          <span className="break-all text-muted-foreground" title={server.url}>
            {hostOf(server.url)}
          </span>
          {!server.enabled && <Badge variant="outline">disabled</Badge>}
        </div>
      ))}
      {missing.map((name) => (
        <div
          key={name}
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="missing-server"
        >
          <Badge variant="destructive">deleted server</Badge>
          <span className="font-mono break-all">{name}</span>
          <span className="text-muted-foreground">
            It is not registered any more, so a new version cannot list it.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onChange(selected.filter((entry) => entry !== name));
            }}
          >
            Remove {name}
          </Button>
        </div>
      ))}
    </Fieldset>
  );
}

/**
 * The egress rule sets a profile uses (docs/decisions/0034-egress-rules.md). A set that applies to all sessions is
 * already included for every profile, so it cannot be added again; naming one that does not exist is refused by the
 * API, so a deleted one shows with a way to drop it.
 */
export function EgressRuleSetPicker({
  selected,
  catalog,
  onChange,
}: {
  selected: string[];
  catalog: RuleSetSummary[] | undefined;
  onChange: (selected: string[]) => void;
}) {
  const missing =
    catalog === undefined ? [] : selected.filter((name) => !catalog.some((s) => s.name === name));
  const empty = catalog?.length === 0;
  return (
    <Fieldset
      legend={fieldLabel("egressRuleSets")}
      {...(empty
        ? {}
        : {
            hint: "Hosts the sandbox may reach, on top of the sets that apply to every session.",
          })}
    >
      {empty && (
        <p className="text-sm text-muted-foreground">
          No rule sets yet.{" "}
          <Link className="underline underline-offset-4" to="/egress">
            Create one
          </Link>
        </p>
      )}
      {(catalog ?? [])
        .filter((set) => set.system !== true)
        .map((set) => {
          const chosen = selected.includes(set.name);
          return (
            <div key={set.name} className="flex flex-wrap items-center gap-2 text-sm">
              <Checkbox
                id={`egress-set-${set.name}`}
                checked={chosen}
                disabled={set.appliesToAll && !chosen}
                onChange={(event) => {
                  onChange(
                    event.target.checked
                      ? [...selected, set.name]
                      : selected.filter((entry) => entry !== set.name),
                  );
                }}
              />
              <Label htmlFor={`egress-set-${set.name}`}>{set.name}</Label>
              <span className="text-muted-foreground">
                {set.ruleCount} {set.ruleCount === 1 ? "rule" : "rules"}
              </span>
              {set.appliesToAll && (
                <Badge variant="warning">
                  {chosen ? "Applies to all sessions" : "Already included: applies to all sessions"}
                </Badge>
              )}
            </div>
          );
        })}
      {missing.map((name) => (
        <div
          key={name}
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="missing-rule-set"
        >
          <Badge variant="destructive">deleted rule set</Badge>
          <span className="font-mono break-all">{name}</span>
          <span className="text-muted-foreground">
            It does not exist any more, so a new version cannot list it.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onChange(selected.filter((entry) => entry !== name));
            }}
          >
            Remove {name}
          </Button>
        </div>
      ))}
    </Fieldset>
  );
}

export function SkillPicker({
  pins,
  catalog,
  onChange,
}: {
  pins: SkillPin[];
  catalog: SkillInfo[] | undefined;
  onChange: (pins: SkillPin[]) => void;
}) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const skill = catalog?.find((entry) => entry.name === name);
  const chosen = skill?.versions.find((entry) => String(entry.version) === version);
  const empty = catalog?.length === 0;
  const detail = (pin: SkillPin) =>
    catalog
      ?.find((entry) => entry.name === pin.name)
      ?.versions.find((v) => v.version === pin.version);
  return (
    <Fieldset
      legend={fieldLabel("skills")}
      {...(empty
        ? {}
        : {
            hint: "Pinned to an exact version; a newer one reaches this profile only when you pin it.",
          })}
    >
      {empty && (
        <p className="text-sm text-muted-foreground">
          No skills published yet.{" "}
          <Link className="underline underline-offset-4" to="/skills">
            Publish one
          </Link>
        </p>
      )}
      {pins.map((pin) => {
        const info = detail(pin);
        const executable = info?.files.some((file) => file.executable) === true;
        return (
          <div
            key={pin.name}
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="skill-pin"
          >
            <span className="font-mono break-all">
              {pin.name}@v{pin.version}
            </span>
            {executable && <Badge variant="outline">executable files</Badge>}
            {info?.disableModelInvocation === true && (
              <Badge variant="outline">model invocation disabled</Badge>
            )}
            {catalog !== undefined && info === undefined && (
              <Badge variant="destructive">version not found</Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              aria-label={`Remove ${pin.name}`}
              onClick={() => {
                onChange(pins.filter((entry) => entry.name !== pin.name));
              }}
            >
              {"×"}
            </Button>
          </div>
        );
      })}
      {!empty && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-40 flex-col gap-1.5">
            <Label htmlFor="skill-name">Skill</Label>
            <Select
              id="skill-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                const next = catalog?.find((entry) => entry.name === event.target.value);
                setVersion(next === undefined ? "" : String(next.currentVersion));
              }}
            >
              <option value="">choose a skill</option>
              {(catalog ?? []).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex min-w-32 flex-col gap-1.5">
            <Label htmlFor="skill-version">Version</Label>
            <Select
              id="skill-version"
              value={version}
              disabled={skill === undefined}
              onChange={(event) => {
                setVersion(event.target.value);
              }}
            >
              {(skill?.versions ?? []).map((entry) => (
                <option key={entry.version} value={String(entry.version)}>
                  v{entry.version}
                  {entry.version === skill?.currentVersion ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={chosen === undefined || skill === undefined}
            onClick={() => {
              if (chosen === undefined || skill === undefined) return;
              const pin: SkillPin = {
                name: skill.name,
                version: chosen.version,
                digest: chosen.digest,
              };
              onChange(
                pins.some((entry) => entry.name === skill.name)
                  ? pins.map((entry) => (entry.name === skill.name ? pin : entry))
                  : [...pins, pin],
              );
              setName("");
              setVersion("");
            }}
          >
            Pin version
          </Button>
        </div>
      )}
    </Fieldset>
  );
}
