# QA Agent Local — Client Demo V2

Local QA for checking code, pages, user flows and recent coding-agent changes against project requirements.

## Modes

- **Code QA** — project rules, routes, required/forbidden code and AST checks.
- **UI QA** — Chromium tests, user flows, runtime errors, accessibility and visual checks.
- **Full Project** — code + UI + API checks with one release gate.
- **AI Change Review** — reviews committed, staged, unstaged and untracked Git changes against saved requirements.

## Requirements

- Node.js 20+ (22 LTS recommended)
- Git for AI Change Review
- Supabase project configured from the web repo
- Gemini API key only if you want natural-language requirement conversion

## First install on Windows

1. Extract the downloaded package.
2. Double-click `install-windows.bat`.
3. Copy/fill `.env` with Supabase values.
4. Optionally add `GEMINI_API_KEY`.
5. Run:

```bash
npm run demo:check
```

6. If every preflight item passes, double-click `start-windows.bat`.
7. Open `http://127.0.0.1:4782` if the browser does not open automatically.

## Environment

```env
PORT=4782
VITE_API_URL=http://127.0.0.1:4782
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
WEB_PORTAL_URL=https://YOUR-WEBSITE.example
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
```

Gemini is optional. QA still works without it.

## Development

```bash
npm install
npm run install:browser
npm run dev
```

Production-like local run:

```bash
npm run build
npm run selftest
npm start
```

## Requirement examples

Currency:

```json
{
  "id": "REQ-001",
  "title": "Prices use EUR",
  "type": "currency",
  "currency": "EUR",
  "symbol": "€",
  "forbiddenTokens": ["USD", "GBP", "£", "$"],
  "paths": ["/shop", "/cart"],
  "severity": "high"
}
```

Engineering rule:

```json
{
  "id": "CODE-001",
  "title": "dispatch is not a React hook dependency",
  "type": "forbidden-hook-dependency",
  "identifier": "dispatch"
}
```

Browser flow using user-facing locators:

```json
{
  "id": "REQ-010",
  "title": "Guest reaches checkout",
  "type": "browser-flow",
  "path": "/cart",
  "steps": [
    { "action": "click", "locator": { "by": "role", "role": "button", "name": "Checkout" } },
    { "action": "expect-url", "contains": "/checkout" }
  ]
}
```

## Privacy

Source scanning, Git checks and Playwright tests run locally. Gemini is called only when the user explicitly converts requirement text. The repository is not uploaded for normal QA.

## Release safety

The GitHub release workflow will not publish the Windows package unless it can install dependencies, install Chromium, build the app and pass `npm run selftest` on a clean Windows runner.
