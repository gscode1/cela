export type CatalogMode = "manage" | "readOnly";

/**
 * `GET /console/config.json`: whether the skills and MCP screens offer writes. No token and no secret in it. The mode
 * hides controls only; the admin API accepts writes either way.
 */
export async function getCatalogMode(signal?: AbortSignal): Promise<CatalogMode> {
  const res = await fetch("/console/config.json", {
    credentials: "omit",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok)
    throw new Error(`could not read the console configuration (HTTP ${String(res.status)})`);
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null && "catalogs" in body) {
    if (body.catalogs === "readOnly") return "readOnly";
    if (body.catalogs === "manage") return "manage";
  }
  throw new Error("the console configuration is not understood");
}
