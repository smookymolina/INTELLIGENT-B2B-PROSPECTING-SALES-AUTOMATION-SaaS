// Auditoria de accesibilidad propia (WCAG 2.1 AA, subconjunto automatizable + teclado).
// Sin dependencias: Chrome headless + CDP por el WebSocket global de Node.
// Uso: node scripts/a11y-audit.mjs [--json]  (WEB_URL por defecto http://127.0.0.1:3000)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:3000";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9300 + Math.floor(Math.random() * 400);
const AS_JSON = process.argv.includes("--json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "a11y-chrome-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* aun no */ }
    await sleep(250);
  }
  throw new Error("Chrome no respondio por CDP");
}

let ws; let seq = 0; const pending = new Map(); const waiters = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function onEvent(name) { return new Promise((res) => waiters.push({ name, res })); }
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
  return r.result.value;
}
async function goto(path) {
  const loaded = onEvent("Page.loadEventFired");
  await send("Page.navigate", { url: WEB + path });
  await Promise.race([loaded, sleep(15000)]);
  for (let i = 0; i < 40; i++) { // el dev server compila rutas bajo demanda
    await sleep(500);
    try { if (await evaluate("document.readyState === 'complete' && !!document.body && document.body.innerText.trim().length > 0")) break; } catch { /* navegando */ }
  }
}

// ---- Auditoria dentro de la pagina ----
const PAGE_AUDIT = `(() => {
  const out = [];
  const add = (sev, rule, msg, el) => out.push({ sev, rule, msg: String(msg).slice(0, 160), el: el ? (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/)[0] : "") + (el.tagName === "A" || el.tagName === "BUTTON" ? " [" + (el.textContent || "").trim().slice(0, 20) + "]" : "")) : "" });
  const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0); };
  const doc = document;
  if (!doc.documentElement.lang) add("critical", "html-lang", "html sin lang: " + (doc.documentElement.outerHTML.match(/(NEXT_[A-Z_]+|Error[^"<]{0,80}|digest[^,]{0,60})/g) || []).slice(0, 4).join(" ; ").split(String.fromCharCode(10)).join(" "));
  if (!doc.title.trim()) add("serious", "title", "sin <title>");
  const h1s = [...doc.querySelectorAll("h1")].filter(vis);
  if (h1s.length === 0) add("serious", "h1", "sin h1");
  if (h1s.length > 1) add("moderate", "h1", "mas de un h1 (" + h1s.length + ")");
  let prev = 0;
  for (const h of doc.querySelectorAll("h1,h2,h3,h4,h5,h6")) { if (!vis(h)) continue; const l = +h.tagName[1]; if (prev && l > prev + 1) add("moderate", "heading-order", "salto h" + prev + " a h" + l + ": " + h.textContent.trim().slice(0, 40), h); prev = l; }
  if (!doc.querySelector("main,[role=main]")) add("serious", "landmark-main", "sin main");
  const isApp = !!doc.querySelector(".bar");
  if (isApp && !doc.querySelector("nav,[role=navigation]")) add("serious", "landmark-nav", "sin nav");
  const txt = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  const labelledBy = (el) => (el.getAttribute("aria-labelledby") || "").split(/\\s+/).map((i) => doc.getElementById(i)).filter(Boolean).map(txt).join(" ").trim();
  const imgName = (el) => [...el.querySelectorAll("img[alt]")].map((i) => i.alt).join("").trim() + [...el.querySelectorAll("svg[aria-label]")].map((i) => i.getAttribute("aria-label")).join("").trim();
  for (const el of doc.querySelectorAll("button,[role=button],a[href],[role=link]")) {
    if (!vis(el)) continue;
    const name = (el.getAttribute("aria-label") || "").trim() || labelledBy(el) || txt(el) || imgName(el) || (el.getAttribute("title") || "").trim();
    if (!name) add("critical", "name-button-link", el.tagName.toLowerCase() + " sin nombre accesible", el);
  }
  for (const el of doc.querySelectorAll("input,select,textarea")) {
    if (el.type === "hidden" || el.type === "submit" || el.type === "button" || !vis(el)) continue;
    const lab = el.labels && el.labels.length ? [...el.labels].map(txt).join(" ") : "";
    const name = (el.getAttribute("aria-label") || "").trim() || labelledBy(el) || lab.trim() || (el.getAttribute("title") || "").trim();
    if (!name) add("critical", "name-input", "campo " + (el.name || el.type) + " sin etiqueta", el);
  }
  for (const el of doc.querySelectorAll("input[type=submit],input[type=button]")) if (!(el.value || el.getAttribute("aria-label"))) add("critical", "name-button-link", "input boton sin valor", el);
  for (const img of doc.querySelectorAll("img")) if (!img.hasAttribute("alt")) add("critical", "img-alt", "img sin alt", img);
  const ids = new Map(); for (const el of doc.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) add("serious", "duplicate-id", "id duplicado " + id + " x" + n);
  const ROLES = new Set("alert alertdialog application article banner button cell checkbox columnheader combobox complementary contentinfo definition dialog directory document feed figure form grid gridcell group heading img link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem".split(" "));
  const BOOL = new Set(["true", "false"]);
  for (const el of doc.querySelectorAll("*")) {
    for (const a of el.getAttributeNames()) {
      if (!a.startsWith("aria-")) continue;
      const v = el.getAttribute(a);
      if (["aria-labelledby", "aria-describedby", "aria-controls"].includes(a)) { for (const i of v.split(/\\s+/).filter(Boolean)) if (!doc.getElementById(i)) add("serious", "aria-ref", a + " apunta a id inexistente " + i, el); }
      else if (["aria-hidden", "aria-expanded", "aria-selected", "aria-required", "aria-disabled", "aria-busy", "aria-modal", "aria-atomic"].includes(a)) { if (!BOOL.has(v)) add("serious", "aria-value", a + "=" + v, el); }
      else if (!/^aria-(label|labelledby|describedby|controls|live|current|invalid|haspopup|pressed|checked|owns|relevant|sort|valuenow|valuemin|valuemax|valuetext|level|posinset|setsize|colcount|rowcount|colindex|rowindex|orientation|placeholder|multiselectable|readonly|autocomplete|activedescendant|errormessage|details|flowto|description|roledescription|keyshortcuts|channel)$/.test(a)) add("serious", "aria-attr", "atributo aria desconocido " + a, el);
    }
    const r = el.getAttribute("role"); if (r && !r.split(/\\s+/).some((x) => ROLES.has(x))) add("serious", "aria-role", "role invalido " + r, el);
    if (el.getAttribute("aria-hidden") === "true" && el.querySelector("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")) add("serious", "aria-hidden-focusable", "aria-hidden con contenido enfocable", el);
  }
  for (const t of doc.querySelectorAll("table")) {
    if (!vis(t) || t.getAttribute("role") === "presentation") continue;
    const ths = t.querySelectorAll("th");
    if (!ths.length) add("serious", "table-th", "tabla sin th", t);
    for (const th of ths) if (th.closest("thead") ? false : !th.getAttribute("scope") && th.parentElement.parentElement.tagName !== "THEAD" && th.cellIndex === 0 && th.parentElement.querySelector("td")) {} // th de fila: opcional
    if (ths.length && ![...ths].some((th) => th.getAttribute("scope") || th.closest("thead"))) add("moderate", "table-scope", "th sin scope ni thead", t);
    if (!t.querySelector("caption") && !t.getAttribute("aria-label") && !t.getAttribute("aria-labelledby")) add("minor", "table-name", "tabla sin caption/aria-label", t);
  }
  // Contraste
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { chain.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = chain.length - 1; i >= 0; i--) base = blend(chain[i], base); return base; };
  const seen = new Set(); let contrastN = 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement; if (!el || seen.has(el) || !vis(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    seen.add(el);
    if (el.closest("[disabled],[aria-disabled=true]") || el.closest(".sr")) continue;
    const s = getComputedStyle(el); if (+s.opacity === 0) continue;
    const fg = parse(s.color); if (!fg) continue;
    const bg = bgOf(el); const f = blend(fg, bg);
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize); const bold = +s.fontWeight >= 700; const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5; contrastN++;
    if (ratio < need) add("serious", "contrast", "contraste " + ratio.toFixed(2) + ":1 < " + need + " (" + s.color + " sobre rgb(" + [bg.r, bg.g, bg.b].map(Math.round) + ") \\"" + txt(el).slice(0, 30) + "\\")", el);
  }
  // Objetivo tactil (WCAG 2.5.8 AA = 24px; 2.5.5 AAA = 44px, informativo)
  for (const el of doc.querySelectorAll("button,input:not([type=hidden]),select,textarea,a[href]")) {
    if (!vis(el)) continue; if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p,li,td,dd,span,label")) continue;
    const r = el.getBoundingClientRect(); if (el.type === "checkbox" || el.type === "radio") { if (r.width < 24 || r.height < 24) { const lab = el.labels && el.labels[0]; const lr = lab ? lab.getBoundingClientRect() : r; if (lr.height < 24) add("minor", "target-size", "checkbox/radio " + Math.round(r.width) + "x" + Math.round(r.height) + " (etiqueta cubre " + Math.round(lr.height) + "px)", el); } continue; }
    const others = [...doc.querySelectorAll("button,input:not([type=hidden]),select,textarea,a[href]")].filter((o) => o !== el && vis(o)); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const near = others.some((o) => { const q = o.getBoundingClientRect(); const dx = Math.max(q.left - cx, 0, cx - q.right), dy = Math.max(q.top - cy, 0, cy - q.bottom); return Math.hypot(dx, dy) < 12; }); if ((r.width < 24 || r.height < 24) && near) add("moderate", "target-size", "objetivo " + Math.round(r.width) + "x" + Math.round(r.height) + "px < 24", el);
  }
  // Formularios: required sin indicacion, autocomplete en campos de identidad
  for (const f of doc.querySelectorAll("form")) { if (!vis(f)) continue; if (!f.querySelector("button[type=submit],button:not([type]),input[type=submit]")) add("moderate", "form-submit", "formulario sin boton de envio", f); }
  for (const b of doc.querySelectorAll("button")) if (vis(b) && b.closest("form") === null && b.type !== "button" && !b.getAttribute("type")) {}
  // Mensajes dinamicos: errores sin role=alert/status
  const msgs = [...doc.querySelectorAll(".notice")].filter((e) => !e.getAttribute("role") && !e.getAttribute("aria-live")); for (const m of msgs) add("minor", "live-region", "aviso sin role/aria-live", m);
  return { out, contrastChecked: contrastN };
})()`;

const FOCUS_PROBE = `(() => {
  const e = document.activeElement; if (!e || e === document.body) return null;
  const s = getComputedStyle(e);
  const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && s.outlineColor !== "transparent" && !/rgba\\(.*, ?0\\)$/.test(s.outlineColor);
  const shadow = s.boxShadow && s.boxShadow !== "none";
  const r = e.getBoundingClientRect();
  return { tag: e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.name ? "[" + e.name + "]" : ""), text: (e.getAttribute("aria-label") || e.textContent || e.value || "").trim().slice(0, 30), visibleIndicator: !!(outline || shadow), onScreen: r.width > 0 && r.height > 0, skip: e.classList.contains("skip") };
})()`;

async function keyTab(shift = false) {
  const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function keyboardAudit() {
  const findings = []; const stops = [];
  await evaluate("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0); 0");
  let repeat = 0; let last = ""; let reachedBody = false;
  for (let i = 0; i < 90; i++) {
    await keyTab();
    const p = await evaluate(FOCUS_PROBE);
    if (!p) { if (i > 3) { reachedBody = true; break; } continue; }
    if (p.tag.startsWith("nextjs-portal")) continue; // overlay de herramientas de desarrollo de Next, no es parte del producto
    const key = p.tag + "|" + p.text;
    if (stops.length && stops[stops.length - 1].key === key && (await evaluate("document.querySelectorAll(\"a[href],button,input,select,textarea,[tabindex]\").length")) > 1) { repeat++; if (repeat >= 2) { findings.push({ sev: "critical", rule: "keyboard-trap", msg: "foco atascado en " + key, el: p.tag }); break; } } else repeat = 0;
    stops.push({ key, ...p });
    if (!p.visibleIndicator) findings.push({ sev: "serious", rule: "focus-visible", msg: "sin indicador de foco en " + key, el: p.tag });
    if (!p.onScreen) findings.push({ sev: "serious", rule: "focus-hidden", msg: "foco en elemento no visible " + key, el: p.tag });
    if (i > 0 && stops.slice(0, -1).some((s) => s.key === key && s.tag === p.tag) && stops.length > 6) { reachedBody = true; break; } // ciclo completo
  }
  const first = stops[0];
  const hasSkipTarget = await evaluate("!!document.querySelector('a.skip, a[href=\"#content\"]')");
  if (hasSkipTarget && first && !first.skip) findings.push({ sev: "moderate", rule: "skip-link", msg: "el primer Tab no llega al enlace de salto", el: first.tag });
  const isApp = await evaluate("!!document.querySelector('.bar')");
  if (isApp && !hasSkipTarget) findings.push({ sev: "moderate", rule: "skip-link", msg: "sin enlace para saltar navegacion (2.4.1)", el: "" });
  return { findings, tabStops: stops.length, reachedEnd: reachedBody };
}

async function setForm(values) {
  await evaluate(`(() => { const v = ${JSON.stringify(values)}; for (const [n, val] of Object.entries(v)) { const el = document.querySelector('[name="' + n + '"]'); if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); } } return 1; })()`);
}

async function main() {
  const url = await connect();
  ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method) { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].name === d.method) { waiters[i].res(d.params); waiters.splice(i, 1); } }
  };
  await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  if (process.argv.includes("--selftest")) { // control negativo: pagina deliberadamente mala, debe producir hallazgos
    const bad = "<html><body><div class=bar></div><button></button><a href=/x></a><input name=q><img src=x><p id=a>x</p><p id=a style=\"color:#aaa;background:#fff\">gris claro</p><h1>a</h1><h3>b</h3><table><tr><td>1</td></tr></table><div role=foo aria-labelledby=nope></div></body></html>";
    const loaded = onEvent("Page.loadEventFired"); await send("Page.navigate", { url: "data:text/html," + encodeURIComponent(bad) }); await Promise.race([loaded, sleep(5000)]); await sleep(300);
    const r = await evaluate(PAGE_AUDIT); const rules = [...new Set(r.out.map((f) => f.sev + ":" + f.rule))]; console.log("SELFTEST detecta:", rules.join(", ")); return [];
  }
  const results = [];
  globalThis.__rawHtml = async (p) => { const t = await evaluate("fetch(" + JSON.stringify(p) + ").then(async (r) => r.status + \" \" + (await r.text()).slice(0, 20000))"); return t; };
  const audit = async (path, label) => {
    await goto(path);
    const finalPath = await evaluate("location.pathname");
    const r = await evaluate(PAGE_AUDIT);
    const k = await keyboardAudit();
    const findings = [...r.out, ...k.findings];
    results.push({ page: label ?? path, finalPath, findings, contrastChecked: r.contrastChecked, tabStops: k.tabStops });
  };

  // Paginas publicas
  await audit("/login", "login");
  await audit("/register", "register");

  // Registro con cuenta de prueba aleatoria (no se imprime ni se guarda)
  const tag = randomBytes(5).toString("hex");
  await goto("/register");
  await setForm({ displayName: "A11y Test", email: `a11y-${tag}@example.test`, password: randomBytes(12).toString("hex"), organizationName: `A11y Org ${tag}` });
  const nav = onEvent("Page.loadEventFired");
  await evaluate("document.querySelector('main form').requestSubmit(); 0");
  await Promise.race([nav, sleep(15000)]); await sleep(1500);
  const where = await evaluate("location.pathname + location.search");
  if (where.startsWith("/register") || where.startsWith("/login")) throw new Error("No se pudo registrar la cuenta de prueba (" + where.replace(/[?&].*/, "") + ")");

  // Dato de prueba: un prospecto para tener detalle
  await goto("/prospects/new");
  await setForm({ name: `Empresa A11y ${tag}`, domain: `a11y-${tag}.example.test`, country: "MX" });
  const nav2 = onEvent("Page.loadEventFired");
  await evaluate("document.querySelector('main form').requestSubmit(); 0");
  await Promise.race([nav2, sleep(15000)]); await sleep(1200);
  if ((await evaluate("location.pathname")) === "/login") throw new Error("La sesion se perdio al crear el prospecto de prueba: " + await evaluate("location.search + document.body.innerText.slice(0,120)"));

  const routes = ["/", "/prospects", "/prospects/new", "/prospects/import", "/prospects/suppressions", "/drafts", "/drafts/new", "/prospects/00000000-0000-4000-8000-000000000000", "/ruta-inexistente", "/privacy", "/sales", "/pricing", "/team", "/analytics", "/analytics/events?metric=prospects_created", "/company", "/account", "/catalog", "/pipeline", "/leads", "/tasks", "/campaigns", "/scoring", "/ai"];
  for (const p of routes) await audit(p);

  // Detalles descubiertos desde la lista
  await goto("/prospects");
  const detail = await evaluate(`(() => { const a = [...document.querySelectorAll('a[href^="/prospects/"]')].map((x) => x.getAttribute('href')).find((h) => /^\\/prospects\\/[0-9a-f-]{8,}$/i.test(h)); return a || null; })()`);
  if (detail) await audit(detail, "/prospects/[id]");
  await goto("/drafts");
  const dd = await evaluate(`(() => { const a = [...document.querySelectorAll('a[href^="/drafts/"]')].map((x) => x.getAttribute('href')).find((h) => /^\\/drafts\\/[0-9a-f-]{8,}$/i.test(h)); return a || null; })()`);
  if (dd) await audit(dd, "/drafts/[id]");
  await goto("/sales");
  const qq = await evaluate(`(() => { const a = [...document.querySelectorAll('a[href^="/quotes/"]')].map((x) => x.getAttribute('href'))[0]; return a || null; })()`);
  if (qq) await audit(qq, "/quotes/[id]");

  if (process.env.A11Y_RAW) { await goto("/prospects"); console.error("RAW:", await globalThis.__rawHtml(process.env.A11Y_RAW)); }
  // Viewport movil para la pagina principal (reflow 1.4.10 basico)
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await goto("/prospects");
  const overflow = await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1");
  results.push({ page: "/prospects (375px)", finalPath: "/prospects", contrastChecked: 0, tabStops: 0, findings: overflow ? [{ sev: "moderate", rule: "reflow", msg: "desbordamiento horizontal de la pagina a 375px", el: "" }] : [] });
  return results;
}

const ORDER = ["critical", "serious", "moderate", "minor"];
let results = [];
try {
  results = await main();
  const total = Object.fromEntries(ORDER.map((s) => [s, 0]));
  const byRule = new Map();
  for (const r of results) for (const f of r.findings) { total[f.sev]++; const k = f.sev + "|" + f.rule + "|" + f.msg.replace(/\d+(\.\d+)?/g, "#").slice(0, 70); const e = byRule.get(k) ?? { sev: f.sev, rule: f.rule, msg: f.msg, el: f.el, pages: new Set() }; e.pages.add(r.page); byRule.set(k, e); }
  if (AS_JSON) console.log(JSON.stringify({ total, results }, null, 1));
  else {
    console.log(`Paginas auditadas: ${results.length}`);
    console.log("Pagina".padEnd(26), "final".padEnd(14), "crit serio mod menor  tabs");
    for (const r of results) { const c = Object.fromEntries(ORDER.map((s) => [s, r.findings.filter((f) => f.sev === s).length])); console.log(r.page.padEnd(26), (r.finalPath ?? "").padEnd(14), String(c.critical).padStart(4), String(c.serious).padStart(4), String(c.moderate).padStart(4), String(c.minor).padStart(5), String(r.tabStops).padStart(5)); }
    console.log("TOTAL", JSON.stringify(total));
    for (const e of [...byRule.values()].sort((a, b) => ORDER.indexOf(a.sev) - ORDER.indexOf(b.sev))) console.log(`[${e.sev}] ${e.rule}: ${e.msg} <${e.el}> en ${[...e.pages].slice(0, 6).join(", ")}${e.pages.size > 6 ? " +" + (e.pages.size - 6) : ""}`);
  }
  process.exitCode = total.critical + total.serious > 0 ? 1 : 0;
} catch (e) {
  console.error("ERROR:", e.message); process.exitCode = 2;
} finally {
  try { ws?.close(); } catch { /* */ }
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil bloqueado: el SO lo limpia */ }
}
