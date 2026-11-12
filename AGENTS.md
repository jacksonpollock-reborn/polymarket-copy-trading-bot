# Memory — Polymarket Copy Trading Bot

## Project
Polymarket copy trading bot running on Mac Mini M4 at ~/copybot. Paper trade mode. 9 Docker services.

## Hard-Won Lessons (DO NOT REPEAT THESE MISTAKES)

### Alchemy / RPC
- **PAYG has NO free tier** — every CU costs $0.45/M from the first one
- **Free plan = 30M CUs/month free** — always stay on Free unless volume justifies PAYG
- **Per-block polling burns ~3-4M CUs/day** = ~$45/month. Never do this.
- **30-second polling = ~7M CUs/month** = fits within Free tier = $0/month
- **Free tier eth_getLogs = 10-block range max** — Alchemy Free tier enforces this. Do NOT use 2000-block range.
- **WebSocket log subscriptions are broken in ethers v6** — use HTTPS JsonRpcProvider + setInterval polling instead
- **Always calculate CU cost BEFORE recommending architecture** — formula: calls/day × CU_per_call × 30 = monthly CUs
- **Correct Free tier setup**: 15s polling, 10 blocks/call, up to 5 calls/poll (multi-chunk catchup). ~14.7M CUs/month steady state.

### ethers.js
- **ethers v5 vs v6**: clob-client v3 pulls in ethers v6. Pin to `"ethers": "^6.0.0"` — do NOT fight it with 5.x
- **ethers v6 API changes**: `ethers.utils.id` → `ethers.id`, `ethers.providers.WebSocketProvider` → `ethers.WebSocketProvider`, `ethers.utils.formatUnits` → `ethers.formatUnits`, `ethers.utils.Interface` → `ethers.Interface`
- **WebSocketProvider `provider.on(filter, cb)` for logs is silently broken in v6** — use `JsonRpcProvider` + `provider.getLogs()` on a timer

### Listener — state persistence
- **lastBlock is in-memory only by default** — every Docker restart starts from `getBlockNumber()`, skipping all blocks mined during downtime
- **Fix: persist lastBlock to Redis** (`listener:lastBlock`) and restore on startup
- **Safety cap on replay**: don't replay more than 50,000 blocks (~1 day) to avoid overwhelming Alchemy on a very stale restart
- **On-chain topic filtering**: pass `makerTopics` as topic[2] in getLogs — eliminates in-memory filtering and ensures nothing slips through
- **Multi-chunk catchup**: loop up to MAX_CHUNKS_PER_POLL (5) × 10-block getLogs calls per poll interval to recover from stale restarts quickly
- **If listener goes silent for days**: check for Alchemy plan changes — Free tier block range restrictions will silently break the listener

### Workspace ↔ ~/copybot sync
- Edits in workspace `./src/` do NOT auto-sync to `~/copybot/src/`
- Always use Desktop Commander `write_file` to write directly to `~/copybot/src/` OR use `cp` commands
- Never tell user to run sed on live files

### Polymarket API
- Leaderboard endpoint: `data-api.polymarket.com/v1/leaderboard` (NOT /leaderboard)
- Valid timePeriod values: `all`, `month`, `week`, `day` (NOT `30d`)
- Response fields: `vol` (NOT `volume`), `pnl`, `proxyWallet`, `userName`
- Positions API: `realizedPnl` and `currentValue` always return 0 — useless for win detection
- Activity API: use for `avgEntryPrice` and `avgBetSize`
- proxyWallet from leaderboard = the maker address in CTF Exchange OrderFilled events — confirmed on-chain

### Redis channels (exact names — DO NOT typo)
- `raw_trade` — listener → filter
- `raw_trade_sell` — filter → risk manager
- `approved_trade` — filter → telegram (SINGULAR — not approved_trades)
- `execute_trade` — telegram → executor
- `listener:lastBlock` — persisted block cursor (DO NOT DELETE)

### Cost mistakes made (learn from these)
1. Recommended per-block WebSocket polling → burned $13.20 in one session
2. Told user PAYG has free tier up to 300M CUs → FALSE, PAYG charges from CU #1
3. Estimated $2-10/month for block polling → actual was ~$45/month
4. Used 2000-block range after Free tier downgrade → every getLogs call failed silently for 4 days, zero alerts

## Current System State
- 9 services: postgres, redis, listener, filter, telegram, executor, risk, whitelist, crawler
- 12 whales in whitelist DB (dual-source: all-time ROI≥20% + monthly ROI≥15%)
- Crawler: every 3h, dual-source leaderboard, recency gates (30d all-time / 14d monthly), avgBet≥$1k
- Listener: 15s polling, 10 blocks/call, up to 5 calls/poll, ethers v6 JsonRpcProvider, lastBlock persisted to Redis, on-chain topic filtering
- Alchemy: Free tier (downgraded April 1 2026) — 10-block getLogs limit, 30M CUs/month
- PAPER_TRADE = true (do NOT flip until 5 real paper cycles confirmed)

## Go-Live Checklist (Phase 7)
- [ ] 5 real paper trade cycles confirmed
- [ ] USDC approved on Polymarket CTF contract
- [ ] All .env values populated
- [ ] Flip PAPER_TRADE=false in executor/index.ts
- [ ] Rebuild executor
