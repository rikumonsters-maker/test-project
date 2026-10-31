# Isolated browser regression tests

Run from `frontend`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The Playwright suite serves the checked-out frontend on `127.0.0.1:5517`. Its
synthetic API intercepts every Worker request to `127.0.0.1:8787` and aborts
all other external requests. Unknown API paths fail with 501. No production
account, Worker, D1 database, Vercel deployment, or credentials are used.

The stale-tab case loads the exact frontend files from the first parent of
PR #17's merge commit (`0e1f71d715e13da1d5096d95de3905d567a737ee`)
through Git. CI checks out full history for this reason. It verifies the old
checkbox's OFF request receives 409 after the notice is acknowledged. The
backend's real SQL, authorization, and response redaction are covered by the
backend Vitest suite, especially `test/common-availability.spec.ts`; the
browser API responses are synthetic and must not be mistaken for a live Worker
integration test.

Screenshots of synthetic data are saved under `frontend/test-results/e2e/` and
ignored by Git. The suite covers Chromium at 375, 390, 430, 768, and 1280 px
in light and dark color schemes. Its Service Worker check confirms registration
and the absence of Cache Storage entries; Safari and installed iPhone PWA
behavior still require device testing. Production user data and login sessions
remain untested by this suite.
