import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModulesContainer } from "@nestjs/core";
import { buildOpenApi, OPERATIONS } from "@prospecting/contracts/openapi";
import { IS_PUBLIC, REQUIRED_PERMISSION } from "../auth/decorators.js";
import { type Api, owner, startApi } from "./harness.js";

/** The OpenAPI file is an executable contract: it must match the generated document and the routes Nest really serves. */
let api: Api;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

const METHODS = ["get", "post", "put", "delete", "patch"];
type Route = { key: string; isPublic: boolean; permission: string | undefined };

function liveRoutes(): Route[] {
  const routes: Route[] = [];
  for (const mod of api.app.get(ModulesContainer).values()) {
    for (const ctrl of mod.controllers.values()) {
      const type = ctrl.metatype as (abstract new (...a: never[]) => unknown) | null;
      if (!type) continue;
      const base = String(Reflect.getMetadata("path", type) ?? "");
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const fn = (type.prototype as Record<string, unknown>)[name];
        if (name === "constructor" || typeof fn !== "function") continue;
        const path = Reflect.getMetadata("path", fn) as string | undefined;
        const method = Reflect.getMetadata("method", fn) as number | undefined;
        if (path === undefined || method === undefined) continue;
        const full = `/${[base, path === "/" ? "" : path].filter(Boolean).join("/")}`.replace(/\/+/g, "/").replace(/:(\w+)/g, "{$1}");
        routes.push({
          key: `${METHODS[method]} ${full}`,
          isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC, fn) ?? Reflect.getMetadata(IS_PUBLIC, type)),
          permission: (Reflect.getMetadata(REQUIRED_PERMISSION, fn) ?? Reflect.getMetadata(REQUIRED_PERMISSION, type)) as string | undefined,
        });
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

describe("OpenAPI v1 contract", () => {
  it("committed docs/api/openapi.v1.json equals the generated document", () => {
    const file = readFileSync(join(import.meta.dirname, "../../../../docs/api/openapi.v1.json"), "utf8");
    expect(JSON.parse(file)).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });

  it("documents exactly the routes the API serves, with matching authentication and permissions", () => {
    const live = liveRoutes();
    const documented = OPERATIONS.map((o) => ({ key: `${o.method} ${o.path}`, isPublic: Boolean(o.public), permission: o.permission })).sort((a, b) => a.key.localeCompare(b.key));
    expect(live).toEqual(documented);
  });

  it("every private operation declares bearer security and 401; every operation declares 500", () => {
    const doc = buildOpenApi() as { paths: Record<string, Record<string, { security: unknown[]; responses: Record<string, unknown> }>> };
    for (const op of Object.values(doc.paths).flatMap((p) => Object.values(p))) {
      if (op.security.length) expect(op.responses["401"]).toBeDefined();
      expect(op.responses["500"]).toBeDefined();
    }
    void owner;
  });
});
