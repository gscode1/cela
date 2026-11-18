import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirm } from "@/components/delete-confirm";
import { ApiError } from "@/lib/api";

function show(props: Partial<Parameters<typeof DeleteConfirm>[0]> = {}) {
  const run = vi.fn<() => Promise<unknown>>();
  const onDeleted = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DeleteConfirm
          kind="skill"
          name="pdf"
          contents="all its versions and files"
          run={run}
          onDeleted={onDeleted}
          onCancel={() => undefined}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { run, onDeleted };
}

describe("DeleteConfirm", () => {
  it("names the API's reasons when the delete is refused, with links to the profiles", async () => {
    const refused = new ApiError(409, 'skill "pdf" cannot be deleted', {
      profiles: [{ name: "docs", version: 2 }],
      sessions: { count: 3, sample: ["s-1", "s-2"] },
    });
    const run = vi.fn(() => Promise.reject(refused));
    const { onDeleted } = show({ run });
    await userEvent.type(screen.getByLabelText("Type pdf to confirm"), "pdf");
    await userEvent.click(screen.getByRole("button", { name: "Delete pdf" }));
    const reasons = await screen.findByTestId("blocked-by");
    expect(reasons).toHaveTextContent("Used by docs");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "/profiles/docs");
    expect(reasons).toHaveTextContent("3 sessions that are not deleted still use it");
    expect(reasons).toHaveTextContent("s-1, s-2");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("says a 409 without reasons means it changed, and keeps the button off while blocked", async () => {
    const run = vi.fn(() => Promise.reject(new ApiError(409, "stale")));
    show({ run });
    await userEvent.type(screen.getByLabelText("Type pdf to confirm"), "pdf");
    await userEvent.click(screen.getByRole("button", { name: "Delete pdf" }));
    expect(await screen.findByTestId("delete-refused")).toHaveTextContent(
      "it changed since this page loaded",
    );
  });

  it("offers no name field and no delete while the page knows it is blocked", () => {
    show({ blocked: true, note: <p>Pinned by docs.</p> });
    expect(screen.queryByLabelText("Type pdf to confirm")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete pdf" })).toBeDisabled();
    expect(screen.getByText("Pinned by docs.")).toBeInTheDocument();
  });
});
