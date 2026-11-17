import { expect, test } from "@playwright/test";

test.describe("console disabled", () => {
  test("/console is a 404 and the API still needs a token", async ({ request }) => {
    for (const path of ["/console", "/console/", "/console/profiles", "/console/assets/index.js"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
    expect((await request.get("/admin/settings")).status()).toBe(401);
  });
});
