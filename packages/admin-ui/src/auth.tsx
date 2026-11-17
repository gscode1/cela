import { useQueryClient } from "@tanstack/react-query";
import { createContext, use, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getSettings, signInMessage } from "@/lib/api";
import { clearDrafts } from "@/lib/drafts";

interface Auth {
  /** The bearer token, or undefined while signed out. It lives in this component's state only. */
  token: string | undefined;
  /** Verifies the token with `GET /admin/settings`; resolves to an error text, or undefined on success. */
  signIn: (token: string) => Promise<string | undefined>;
  signOut: () => void;
}

const AuthContext = createContext<Auth | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | undefined>(undefined);

  const signIn = useCallback(
    async (candidate: string) => {
      try {
        const settings = await getSettings(candidate);
        queryClient.setQueryData(["settings"], settings);
        setToken(candidate);
        return undefined;
      } catch (error) {
        return signInMessage(error);
      }
    },
    [queryClient],
  );

  const signOut = useCallback(() => {
    setToken(undefined);
    queryClient.clear();
    clearDrafts();
  }, [queryClient]);

  const value = useMemo(() => ({ token, signIn, signOut }), [token, signIn, signOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (auth === undefined) throw new Error("useAuth needs an AuthProvider");
  return auth;
}
