import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { explainEgress, SESSION_ID } from "@/lib/api/egress";
import type { EgressRule, ExplainRequest, ExplainResult } from "@/lib/api/egress";
import { portsText } from "@/lib/egress-form";
import { useProfilesQuery } from "@/lib/queries";
import { HostText } from "@/pages/egress/rule-manager";

function RuleLine({ rule }: { rule: EgressRule }) {
  return (
    <span>
      #{rule.id} {rule.effect} <HostText host={rule.host} />, ports {portsText(rule.ports)}
      {rule.effect === "allow" ? `, ${rule.route}` : ""}
      {rule.private ? ", private" : ""}
      {rule.ruleSet !== null && (
        <>
          {", in "}
          <Link className="underline" to={`/egress/sets/${encodeURIComponent(rule.ruleSet)}`}>
            {rule.ruleSet}
          </Link>
        </>
      )}
      {rule.sessionId !== null && `, session rule for ${rule.sessionId}`}
    </span>
  );
}

/** What `POST /admin/egress/explain` answered, as a person reads it. */
export function ExplainResultView({ result }: { result: ExplainResult }) {
  const allowed = result.decision === "allow";
  return (
    <section
      aria-label="Explain result"
      className="flex flex-col gap-3"
      data-testid="explain-result"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={allowed ? "secondary" : "destructive"} data-testid="explain-decision">
          {allowed ? "allow" : "deny"}
        </Badge>
        <span className="text-sm">
          <code>{result.host}</code> port {result.port}
          {allowed && result.route !== null ? `, route ${result.route}` : ""}
        </span>
      </div>
      <p className="text-sm break-words" data-testid="explain-reason">
        {result.reason}
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Matched rule</dt>
        <dd data-testid="explain-matched">
          {result.matchedRule === null ? "none" : <RuleLine rule={result.matchedRule} />}
        </dd>
        <dt className="text-muted-foreground">Rule set</dt>
        <dd>
          {result.ruleSet === null ? (
            result.matchedRule?.sessionId != null ? (
              "a session rule"
            ) : (
              "none"
            )
          ) : (
            <Link className="underline" to={`/egress/sets/${encodeURIComponent(result.ruleSet)}`}>
              {result.ruleSet}
            </Link>
          )}
        </dd>
        <dt className="text-muted-foreground">Rule sets considered</dt>
        <dd>
          the sets that apply to all
          {result.profileRuleSets.length > 0 && `, and ${result.profileRuleSets.join(", ")}`}
          {result.profileSource === "principal" && " (the sets stored for that session)"}
        </dd>
        <dt className="text-muted-foreground">Addresses</dt>
        <dd>
          {result.addressesChecked
            ? "judged by the addresses you gave"
            : "not checked: only names were judged (no DNS lookup is made)"}
        </dd>
        <dt className="text-muted-foreground">Rules at revision</dt>
        <dd>{result.revision}</dd>
      </dl>
      {result.conflictingRules.length > 0 && (
        <Alert variant="warning" data-testid="explain-conflict">
          <p className="font-medium">Two equally specific allows disagree on the route.</p>
          <ul className="list-disc pl-5">
            {result.conflictingRules.map((rule) => (
              <li key={rule.id}>
                <RuleLine rule={rule} />
              </li>
            ))}
          </ul>
          <p>Change one of them so that both name the same route, or remove one.</p>
        </Alert>
      )}
      {result.needsPrivate === true && (
        <Alert variant="warning" data-testid="explain-needs-private">
          The host resolves to a private address, so only an allow rule with <code>private</code>{" "}
          can open it: an exact host or a cidr, explicit ports, route direct. The network policy
          must allow it too.
        </Alert>
      )}
    </section>
  );
}

/** Why a connection would be allowed or denied, for the rules stored now. */
export function ExplainPanel() {
  const { token } = useAuth();
  const profiles = useProfilesQuery();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [sessionId, setSessionId] = useState("");
  const [profile, setProfile] = useState("");
  const [addresses, setAddresses] = useState("");
  const addressList = addresses.split(/[\s,]+/).filter((entry) => entry !== "");
  const portNumber = Number(port);
  const problems: string[] = [];
  if (host.trim() === "") problems.push("enter a host");
  if (!/^\d{1,5}$/.test(port) || portNumber < 1 || portNumber > 65535)
    problems.push("the port is from 1 to 65535");
  if (sessionId.trim() !== "" && !SESSION_ID.test(sessionId.trim()))
    problems.push("a session id is a lowercase UUID");
  if (addressList.length > 16) problems.push("at most 16 addresses");
  const explain = useMutation({
    mutationFn: () => {
      const request: ExplainRequest = { host: host.trim(), port: portNumber };
      if (sessionId.trim() !== "") request.sessionId = sessionId.trim();
      if (profile !== "") request.profile = profile;
      if (addressList.length > 0) request.addresses = addressList;
      return explainEgress(token ?? "", request);
    },
  });
  return (
    <Card aria-label="Explain">
      <CardHeader>
        <CardTitle>Explain</CardTitle>
        <CardDescription>
          Ask what the stored rules say about a connection. Give a session to see what it would get:
          without a profile, its stored rule sets are used (the ones its profile named when it was
          created). Nothing is resolved, so name the addresses to ask what happens if the host
          resolves to them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            explain.mutate();
          }}
        >
          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="explain-host">Host</Label>
              <Input
                id="explain-host"
                autoComplete="off"
                value={host}
                onChange={(event) => {
                  setHost(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="explain-port">Port</Label>
              <Input
                id="explain-port"
                inputMode="numeric"
                value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="explain-profile">Profile (optional)</Label>
            <Select
              id="explain-profile"
              value={profile}
              onChange={(event) => {
                setProfile(event.target.value);
              }}
            >
              <option value="">None: only the sets that apply to all</option>
              {(profiles.data?.profiles ?? []).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="explain-session">Session id (optional)</Label>
            <Input
              id="explain-session"
              autoComplete="off"
              value={sessionId}
              onChange={(event) => {
                setSessionId(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="explain-addresses">Addresses (optional)</Label>
            <Input
              id="explain-addresses"
              autoComplete="off"
              placeholder="10.0.4.7, 93.184.216.34"
              value={addresses}
              onChange={(event) => {
                setAddresses(event.target.value);
              }}
            />
          </div>
          {problems.length > 0 && host !== "" && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div>
            <Button type="submit" disabled={problems.length > 0 || explain.isPending}>
              Explain
            </Button>
          </div>
        </form>
        {explain.isError && <Alert variant="destructive">{explain.error.message}</Alert>}
        {explain.isSuccess && <ExplainResultView result={explain.data} />}
      </CardContent>
    </Card>
  );
}
