import { useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { McpServerRef, SkillInfo, SkillPin } from "@/lib/api/profiles";

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

/**
 * A tool list, with the difference the API keeps: "all" is an omitted field, a selection is an explicit list, and an
 * empty selection means no tools at all.
 */
export function ToolList({
  idPrefix,
  legend,
  hint,
  all,
  selected,
  offered,
  installed,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  hint: string;
  all: boolean;
  selected: string[];
  /** The tools that may be picked: the installed ones, narrowed for `modelTools` by the enabled tools. */
  offered: readonly string[];
  installed: readonly string[];
  onChange: (all: boolean, selected: string[]) => void;
}) {
  const unknown = selected.filter((name) => !installed.includes(name));
  return (
    <Fieldset legend={legend} hint={hint}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-all`}
          checked={all}
          onChange={(event) => {
            onChange(event.target.checked, event.target.checked ? [] : [...offered]);
          }}
        />
        <Label htmlFor={`${idPrefix}-all`}>All (field omitted)</Label>
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
            </div>
          ))}
          {selected.length === 0 && <p className="text-sm">No tools: an empty list.</p>}
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
            The orchestrator no longer has this tool, so the API refuses a new version that lists
            it.
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
  return (
    <Fieldset
      legend="MCP servers"
      hint="Servers from the MCP catalog. A session gets tool_search and their tools. Attaching one publishes a new version, so it applies to new sessions only."
    >
      {catalog?.length === 0 && (
        <p className="text-sm text-muted-foreground">The catalog has no servers.</p>
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
          <span className="break-all text-muted-foreground">{server.url}</span>
          {!server.enabled && (
            <Badge variant="outline">disabled: its tools are unavailable until it is enabled</Badge>
          )}
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
            It is not in the catalog, so the API refuses a new version that lists it.
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

function shortDigest(digest: string | undefined): string {
  return digest === undefined ? "" : digest.slice(0, 12);
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
  const detail = (pin: SkillPin) =>
    catalog
      ?.find((entry) => entry.name === pin.name)
      ?.versions.find((v) => v.version === pin.version);
  return (
    <Fieldset
      legend="Skills"
      hint="Exact versions. A published version never changes, and a new one reaches this profile only when you pin it."
    >
      {pins.length === 0 && <p className="text-sm text-muted-foreground">No skills pinned.</p>}
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
            {pin.digest !== undefined && (
              <span className="font-mono text-xs text-muted-foreground">
                {shortDigest(pin.digest)}
              </span>
            )}
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
    </Fieldset>
  );
}
