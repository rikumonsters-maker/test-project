# Isolated browser regression tests

Run from `frontend`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The Playwright suite uses two isolated paths:

- `shared.spec.mjs` serves the checked-out frontend on `127.0.0.1:5517`.
  Its synthetic API intercepts every Worker request to `127.0.0.1:8787` and
  aborts all other external requests. Unknown API paths fail with 501.
- `local-worker.spec.mjs` serves the frontend on `127.0.0.1:5500` and starts
  the actual Worker on `127.0.0.1:8787` with `wrangler.rc-test.jsonc`. The
  D1 ID is synthetic, the binding is local, and storage is kept under
  `frontend/test-results/local-worker-db`. The startup script checks an exact
  migration allowlist before using `--local`; migration 0011 is absent. Every
  test account, group and event is synthetic. Browser requests to other hosts
  are aborted.

No production account, Worker, D1 database, Vercel deployment, or credentials
are used. The CI browser job installs backend dependencies for local Wrangler.

The stale-tab cases load the exact frontend files from the first parent of
PR #17's merge commit (`0e1f71d715e13da1d5096d95de3905d567a737ee`)
through Git. CI checks out full history for this reason. The real Worker
integration case checks old OFF/ON behavior, acknowledgement, the stale
checkbox's 409, authorization and cross-group redaction. The backend Vitest
suite continues to cover detailed SQL, authorization and response redaction.

Screenshots of synthetic data are saved under `frontend/test-results/e2e/` and
ignored by Git. The suite covers Chromium at 375, 390, 430, 768, and 1280 px
in light and dark color schemes. Its Service Worker check confirms registration
and the absence of Cache Storage entries; Safari and installed iPhone PWA
behavior still require device testing. Production user data and login sessions
remain untested by this suite.
