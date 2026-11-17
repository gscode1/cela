import { useState } from "react";
import type { SyntheticEvent } from "react";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignIn() {
  const { signIn } = useAuth();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (token.trim() === "" || busy) return;
    setBusy(true);
    void signIn(token.trim()).then((message) => {
      setBusy(false);
      // On success the provider swaps this screen out; keeping the token in the field would only keep a copy.
      if (message !== undefined) setError(message);
    });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>pi-durable console</CardTitle>
          <CardDescription>
            Sign in with your owner token. It stays in this tab&apos;s memory and is asked for again
            after a reload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                type="password"
                autoComplete="off"
                autoFocus
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                }}
              />
            </div>
            {error !== undefined && <Alert variant="destructive">{error}</Alert>}
            <Button type="submit" disabled={busy || token.trim() === ""}>
              {busy ? "Checking" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
