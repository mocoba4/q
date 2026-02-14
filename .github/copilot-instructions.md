# Copilot instructions (Checker)

## Big picture
- This repo is a Node.js automation “checker” that watches a CGTrader modeling-requests page and (optionally) auto-accepts jobs fast.
- Core runtime is [checker/index.js](../checker/index.js): a multi-account Playwright “swarm”. Account 1 is the **Spotter** (observes + triggers), Accounts 2+ are **Workers** (click accept in parallel).
- Local helper [simulate_logic.js](../simulate_logic.js) is a quick sandbox for job parsing/price logic (no Playwright).

## How it works (data flow)
- Spotter loads `TARGET_URL` and listens for the `available-requests` API response.
- Jobs are parsed into `{ id, url, price, isGrouped, variations, pricePerUnit }` and immediately dispatched via `triggerSwarm()`.
- Dispatch is greedy by **capacity** (see `getCapacity()` selectors) and filtered by:
  - `MIN_PRICE_SINGLE` for single jobs
  - `MIN_PRICE_VARIATION` for grouped jobs (uses `pricePerUnit`)
- Workers open new tabs per job and run the “Accept task” + confirm modal flow (`processJob()`).
- Notifications go to Telegram and/or ntfy (`sendDualAlert()`), often with screenshots.

**Pricing note:** for grouped jobs, `price` is taken from `attributes.groupData.pricingInformation.price` (falls back to `attributes.pricingInformation.price`/`compensation`). This matches the UI “$XX.XX • N variations”.

## Developer workflows
- Install deps: `cd checker` then `npm ci`
- Install Playwright Chromium:
  - local: `cd checker` then `npx playwright install chromium`
  - CI reference: [ .github/workflows/checker.yml](workflows/checker.yml)
- Run once (local mode): `cd checker` then `npm start` (or `node index.js`)
- Run continuously locally: [start_local.bat](../start_local.bat) loops every 60s.

## Configuration conventions (.env)
- Copy [checker/.env.example](../checker/.env.example) to `checker/.env`.
- Required: `TARGET_URL`, `LOGIN_URL`, `CG_EMAIL`, `CG_PASSWORD`.
- Multi-account naming: `CG_EMAIL2`/`CG_PASSWORD2` … up to `5`, with `ACCOUNT_COUNT` controlling how many are active.
- Safety switch: `CHECK_ONLY=1` disables auto-accept (Spotter only; still notifies).
- UI/headless: `SHOW_BROWSER=true` runs headed; default is headless.
- Session persistence: storage state is written per account to `checker/session_<id>.json`.
  - CI cache note: if you want sessions to persist in GitHub Actions, cache `checker/session_*.json` (not `checker/session.json`).

## Repo-specific patterns to preserve
- “Secret masking bypass” logs: URLs/prices/IDs are intentionally spaced (e.g. `String(price).split('').join(' ')` and `https://` → `https:// `). Keep this behavior when adjusting logs.
- Resource blocking is asymmetric by design: Worker contexts block images/fonts/media for speed; Spotter keeps them for screenshots.
- Concurrency guard: `isDispatching` is a lock; avoid adding code paths that can re-enter `triggerSwarm()` while dispatching.
- Selectors are brittle by nature (UI scraping). When changing selectors in `getCapacity()` or accept flow, validate against the live UI.
