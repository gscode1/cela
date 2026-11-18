import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type {
  McpServerRef,
  SandboxSize,
  SandboxSizeCatalog,
  SkillInfo,
  SkillPin,
} from "@/lib/api/profiles";
import { fieldLabel } from "@/lib/field-labels";
import { hostOf } from "@/lib/profile-form";
import { toolDescription } from "@/lib/tool-descriptions";

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
 * The profile's sandbox size and the sizes a caller may ask for (docs/decisions/0030-sandbox-sizes.md). Sizes are the
 * deployment's (chart values); one that is no longer defined stays visible with a way to drop it, since the API refuses
 * to store it again.
 */
export function SandboxSizePicker({
  size,
  allowed,
  catalog,
  onChange,
}: {
  size: string;
  allowed: string[];
  catalog: SandboxSizeCatalog | undefined;
  onChange: (change: { sandboxSize?: string; sandboxSizes?: string[] }) => void;
}) {
  const sizes = catalog?.sizes ?? [];
  const defined = (name: string): boolean => sizes.some((entry) => entry.name === name);
  if (catalog !== undefined && sizes.length === 0 && size === "" && allowed.length === 0) {
    return (
      <Fieldset legend={fieldLabel("sandboxSize")}>
        <p className="text-sm text-muted-foreground">This deployment defines no sandbox sizes.</p>
      </Fieldset>
    );
  }
  const effective = size === "" ? (catalog?.defaultSize ?? "") : size;
  return (
    <Fieldset
      legend={fieldLabel("sandboxSize")}
      hint="CPU, memory and workspace of this profile's sandboxes. Applies to new sessions only."
    >
      <Select
        id="profile-sandbox-size"
        aria-label={fieldLabel("sandboxSize")}
        value={size}
        onChange={(event) => {
          onChange({ sandboxSize: event.target.value });
        }}
      >
        <option value="">
          Inherit (global default{catalog?.defaultSize ? `: ${catalog.defaultSize}` : ""})
        </option>
        {sizes.map((entry) => (
          <option key={entry.name} value={entry.name}>
            {entry.name}: {sizeSummary(entry)}
          </option>
        ))}
        {size !== "" && catalog !== undefined && !defined(size) && (
          <option value={size}>{size} (not defined)</option>
        )}
      </Select>
      <p className="text-sm font-medium">{fieldLabel("sandboxSizes")}</p>
      {sizes
        .filter((entry) => entry.name !== effective)
        .map((entry) => (
          <div key={entry.name} className="flex flex-wrap items-center gap-2 text-sm">
            <Checkbox
              id={`size-${entry.name}`}
              checked={allowed.includes(entry.name)}
              onChange={(event) => {
                onChange({
                  sandboxSizes: event.target.checked
                    ? [...allowed, entry.name]
                    : allowed.filter((name) => name !== entry.name),
                });
              }}
            />
            <Label htmlFor={`size-${entry.name}`}>{entry.name}</Label>
            <span className="text-muted-foreground">{sizeSummary(entry)}</span>
          </div>
        ))}
      {catalog !== undefined &&
        allowed
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
                  onChange({ sandboxSizes: allowed.filter((entry) => entry !== name) });
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
  bare = false,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  /** Inside another disclosure: no frame of its own. */
  bare?: boolean;
  all: boolean;
  selected: string[];
  /** The tools that may be picked: the installed ones, narrowed for `modelTools` by the enabled tools. */
  offered: readonly string[];
  installed: readonly string[];
  onChange: (all: boolean, selected: string[]) => void;
}) {
  const unknown = selected.filter((name) => !installed.includes(name));
  const Frame = bare ? BareFrame : Fieldset;
  return (
    <Frame legend={legend}>
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
    </Frame>
  );
}

/** The same heading as a fieldset, without the frame: for a list that already sits in one. */
function BareFrame({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{legend}</p>
      {children}
    </div>
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
              variant="outline"
              onClick={() => {
                onChange(pins.filter((entry) => entry.name !== pin.name));
              }}
            >
              Remove {pin.name}
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
