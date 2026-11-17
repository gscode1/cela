import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { App } from "@/app";
import { AuthProvider } from "@/auth";

export function renderApp(path = "/"): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

export async function signIn(token: string): Promise<void> {
  await userEvent.type(screen.getByLabelText("Token"), token);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}
