import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const ROUTES = ["/", "/account", "/ai", "/analytics", "/campaigns", "/catalog", "/company", "/drafts", "/leads", "/pipeline", "/pricing", "/privacy", "/prospects", "/sales", "/scoring", "/tasks", "/team"];

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id} (${v.impact}): ${v.nodes.length} nodos`);
}

test("páginas públicas sin errores críticos ni serios de axe", async ({ page }) => {
  for (const path of ["/login", "/register"]) {
    await page.goto(path);
    expect(await violations(page), path).toEqual([]);
  }
});

test("registro por teclado y páginas autenticadas sin errores críticos ni serios", async ({ page }) => {
  const id = randomBytes(4).toString("hex");
  await page.goto("/register");
  // recorrido por teclado: cada campo recibe foco con Tab en orden
  await page.getByLabel("Tu nombre").focus();
  await page.keyboard.type("Prueba Browser");
  await page.keyboard.press("Tab");
  await page.keyboard.type(`pw-${id}@example.com`);
  await page.keyboard.press("Tab");
  await page.keyboard.type(`Clave-${id}-segura!`);
  await page.keyboard.press("Tab");
  await page.keyboard.type(`Org ${id}`);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Crear cuenta" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/register"));

  const failures: string[] = [];
  for (const path of ROUTES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(page.locator("h1").first(), `${path} tiene h1`).toBeVisible();
    for (const v of await violations(page)) failures.push(`${path}: ${v}`);
  }
  expect(failures).toEqual([]);
});

test("enlace de salto y foco visible", async ({ page }) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
  });
  expect(outline.style !== "none" || outline.shadow !== "none").toBe(true);
});
