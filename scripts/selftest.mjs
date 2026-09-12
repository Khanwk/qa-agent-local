import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runQa } from "../dist/server/core/scanner.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-agent-selftest-"));
await fs.mkdir(path.join(root, "src", "app", "(shop)", "cart"), { recursive: true });
await fs.writeFile(path.join(root, "src", "app", "(shop)", "cart", "page.tsx"), `export default function Cart(){ return <div>{\`Total: \${100}\`} € 100</div> }`);
await fs.writeFile(path.join(root, "src", "feature.tsx"), `useEffect(() => { dispatch(load()); }, []); const foo = "foo";`);
await fs.mkdir(path.join(root, "src", "app", "products", "[slug]"), { recursive: true });
await fs.writeFile(path.join(root, "src", "app", "products", "[slug]", "page.tsx"), `export default function Product(){ return <div>EUR €</div> }`);

const code = await runQa({
  projectName: "Self test",
  projectPath: root,
  mode: "code",
  requirements: [
    { id: "CUR", title: "EUR", type: "currency", currency: "EUR", symbol: "€", forbiddenTokens: ["USD", "$"], enabled: true },
    { id: "ROUTE", title: "Grouped route", type: "route", path: "/cart", enabled: true },
    { id: "DYNAMIC", title: "Dynamic route", type: "route", path: "/products/demo", enabled: true },
    { id: "HOOK", title: "No dispatch dep", type: "forbidden-hook-dependency", identifier: "dispatch", enabled: true },
    { id: "TOKENS", title: "All tokens", type: "text-search", required: ["foo", "bar"], enabled: true }
  ]
});

const byId = Object.fromEntries(code.findings.map((f) => [f.requirementId, f]));
if (byId.CUR?.status !== "pass") throw new Error(`Currency interpolation regression: ${JSON.stringify(byId.CUR)}`);
if (byId.ROUTE?.status !== "pass") throw new Error(`Route-group regression: ${JSON.stringify(byId.ROUTE)}`);
if (byId.DYNAMIC?.status !== "pass") throw new Error(`Dynamic-route regression: ${JSON.stringify(byId.DYNAMIC)}`);
if (byId.HOOK?.status !== "pass") throw new Error(`Hook AST regression: ${JSON.stringify(byId.HOOK)}`);
if (byId.TOKENS?.status !== "fail") throw new Error(`Required-all regression: ${JSON.stringify(byId.TOKENS)}`);

await fs.writeFile(path.join(root, "src", "bad-hook.tsx"), `useEffect(() => { dispatch(load()); }, [dispatch]);`);
const badHook = await runQa({ projectName: "Bad hook", projectPath: root, mode: "code", requirements: [{ id: "HOOK-BAD", title: "Detect bad dispatch dep", type: "forbidden-hook-dependency", identifier: "dispatch", enabled: true }] });
if (badHook.findings.find((f) => f.requirementId === "HOOK-BAD")?.status !== "fail") throw new Error("AST hook violation was not detected");
await fs.rm(path.join(root, "src", "bad-hook.tsx"), { force: true });

const empty = await runQa({ projectName: "Empty", projectPath: root, mode: "code", requirements: [] });
if (empty.score !== 0 || empty.releaseStatus === "ready") throw new Error("Empty requirements must never produce a ready/100% result");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  const price = req.url === "/empty" ? "No price is displayed" : "€ 12.00";
  res.end(`<!doctype html><html lang="en"><head><title>QA Agent Self Test</title></head><body><main><h1>Shop</h1><p>${price}</p><button>Checkout</button></main></body></html>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
try {
  const browser = await runQa({
    projectName: "Browser self test",
    projectPath: root,
    baseUrl: `http://127.0.0.1:${port}`,
    mode: "ui",
    requirements: [
      { id: "UI-CUR", title: "Rendered EUR", type: "currency", currency: "EUR", symbol: "€", forbiddenTokens: ["USD", "$"], paths: ["/"], enabled: true },
      { id: "A11Y", title: "Accessibility", type: "accessibility", path: "/", enabled: true },
      { id: "UI-CUR-EMPTY", title: "Currency page without price", type: "currency", currency: "EUR", symbol: "€", forbiddenTokens: ["USD", "$"], paths: ["/empty"], enabled: true }
    ]
  });
  if (browser.findings.some((f) => f.status === "fail")) throw new Error(`Browser self test failed: ${JSON.stringify(browser.findings)}`);
  if (browser.findings.find((f) => f.requirementId === "UI-CUR-EMPTY")?.status !== "needs_review") throw new Error("Missing rendered currency should require review, not silently pass");
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log("QA Agent self-test passed: deterministic rules, route groups, dynamic routes, AST positive/negative checks, empty release gate, currency presence, axe-core and Chromium smoke tests.");
