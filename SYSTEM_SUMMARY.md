# Polymarket Copy Trading Bot — System Summary
**Last updated:** 2026-03-23
**Status:** Paper trade mode, all 9 services running, 24 whales monitored

---

## What This System Does

Automatically discovers elite Polymarket traders (whales), monitors their on-chain trades in real time, sends you a Telegram alert whenever they place a qualifying bet, and executes a proportional copy trade when you approve it.

---

## Architecture: 9 Docker Services

```
[Crawler] ─────────────────────────────────────┐
  (every 6h, finds new whales via leaderboard)  │
                                                 ▼
[Whitelist DB] ◄──────────────────────── [Whitelist Server :3000]

[Polygon Chain] ──► [Listener] ──► Redis: raw_trade
                                        │
                                        ▼
                                    [Filter]
                                        │
                            passes? ───►│◄─── fails? → dropped
                                        │
                                        ▼
                               Redis: approved_trade
                                        │
                                        ▼
                                   [Telegram Bot]
                                        │
                              You tap ✅ EXECUTE
                                        │
                                        ▼
                               Redis: execute_trade
                                        │
                                        ▼
                                   [Executor]
                                    (PAPER or LIVE)
                                        │
                                        ▼
                                  [Postgres: positions]
                                        │
                                        ▼
                               [Risk Manager] ◄── whale SELL events
                                (stop-loss, exit mirror)
```

---

## Service-by-Service Logic

### 1. Crawler (`src/crawler/index.ts`)
**Runs every 6 hours.**

- Fetches top 100 wallets from Polymarket leaderboard for `timePeriod=all` AND `timePeriod=month` (paginated 20/page × 5 pages each)
- **Gate 1 — Leaderboard:**
  - Must appear on BOTH all-time AND monthly lists (consistency filter)
  - `pnl > 0`
  - `vol ≥ $50,000`
  - `ROI ≥ 15%` (pnl / vol)
- **Gate 2 — Activity API:**
  - `avgEntryPrice` between 0.15–0.80 (avoids near-certain bets)
  - `avgBetSize ≥ $3,000` (serious money)
- On pass: submits to whitelist service with `score=90`, `winRate = min(0.95, 0.60 + roi)`
- API: `data-api.polymarket.com/v1/leaderboard` and `/activity`

### 2. Whitelist Server (`src/whitelist/server.ts` + `feeder.ts`)
**Always running on port 3000.**

- Receives POST `/whitelist/evaluate` from crawler
- Uses inline stats (winRate, avgBetSize) passed by crawler — does NOT query separate DB
- Upserts qualifying wallets into `whitelist` table in Postgres
- Threshold: `score ≥ 80`, `winRate ≥ 0.60`, `avgBetSize ≥ $3,000`

### 3. Listener (`src/listener/index.ts`)
**Always running. Loads whitelist at startup.**

- Connects to Polygon via WebSocket (Alchemy)
- Subscribes to `OrderFilled` events on CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- For each event: checks if `maker` is in whitelist
- Captures: tokenId, side (BUY/SELL), usdcAmount, shares, and snapshots whale's **total** balance on-chain
- Publishes to Redis `raw_trade`
- ⚠️ Loads whitelist once at startup — must be restarted to pick up new crawler additions

### 4. Filter (`src/filter/index.ts`)
**Always running.**

- Subscribes to Redis `raw_trade`
- SELL events → routed to `raw_trade_sell` for risk manager
- BUY events → evaluated:
  - Price between $0.10–$0.85
  - Resolves within 45 days
  - Simulates slippage against live orderbook — rejects if >3%
  - Checks `tracker_alerts` table for "HIGH CONVICTION" insider anomaly signals
- Calculates position size: 20% of balance (30% if high conviction)
- Publishes approved trades to `approved_trade`

### 5. Telegram Bot (`src/telegram/index.ts`)
**Always running.**

- Subscribes to `approved_trade`
- Sends formatted alert with whale wallet, market question, price, position size, slippage
- Inline buttons: ✅ EXECUTE TRADE / ❌ PASS
- Stores pending trade for 10 minutes — expires if not actioned
- On EXECUTE: publishes to `execute_trade`

### 6. Executor (`src/executor/index.ts`)
**Always running.**

- Subscribes to `execute_trade`
- **PAPER_TRADE = true** (current) — logs trade, sends Telegram confirmation, does NOT submit to CLOB
- **PAPER_TRADE = false** (live) — creates and signs order via `@polymarket/clob-client`, posts FOK order, saves position to DB

### 7. Risk Manager (`src/risk/index.ts`)
**Always running. Checks every 30 seconds.**

- Subscribes to `raw_trade_sell` — mirrors whale exits proportionally
- Failsafe check every 30s: if a position is down >40% AND resolves within 24h → sends Telegram "CUT LOSSES?" alert
- On auto-exit: calculates PnL, updates DB, sends Telegram `🔄 AUTO EXIT` message

### 8. Postgres
Tables: `whitelist`, `positions`

### 9. Redis
Channels: `raw_trade` → `raw_trade_sell` / `approved_trade` → `execute_trade`

---

## Data Flow (Full Happy Path)

1. Crawler runs → finds 2 whales → writes to `whitelist` table
2. Listener restarts → loads 2 wallets → watches chain
3. Whale wallet places BUY on Polygon CTF Exchange
4. Listener detects `OrderFilled` event → publishes `raw_trade`
5. Filter checks price, days-to-resolve, slippage → passes → publishes `approved_trade`
6. Telegram sends alert to you with ✅ / ❌
7. You tap ✅ → `execute_trade` published
8. Executor submits FOK order to Polymarket CLOB → saves to `positions`
9. Later: whale sells → risk manager mirrors exit proportionally
10. Failsafe: if market is decaying and you're deep underwater → Telegram warning

---

## Current Configuration

| Parameter | Value |
|---|---|
| Crawler interval | Every 3 hours |
| Min vol (leaderboard gate) | $50,000 |
| Min ROI (leaderboard gate) | 10% |
| Min avg bet size | $1,500 |
| Min price filter | $0.10 |
| Max price filter | $0.85 |
| Max days to resolve | 45 |
| Max slippage | 3% |
| Default position size | 20% of balance |
| High conviction position | 30% of balance |
| Stop-loss trigger | Down 40% AND <24h to resolve |
| Paper trade mode | **TRUE** |

---

## Known Limitations & Issues

1. **Listener doesn't auto-reload whitelist** — new whales added by crawler won't be watched until listener restarts. Fix: add a `setInterval` to reload whitelist every hour.

2. **Whale exits: notification only, no Telegram approval** — the risk manager auto-executes exits without asking you. This is by design but means exits in paper mode are also not user-approved.

3. **tokenId: undefined in paper trade logs** — test payloads don't include `trade.tokenId`. In production this is populated by the listener from `makerAssetId`.

4. **`approved_trade` vs `approved_trades` channel naming** — telegram subscribes to `approved_trade` (singular). Keep consistent when injecting test payloads.

---

## Go-Live Checklist (Phase 7)

- [ ] All `.env` values populated (PRIVATE_KEY, CLOB keys, Alchemy WSS, Telegram)
- [ ] USDC approved on Polymarket CTF contract (via Polymarket UI)
- [ ] Ran ≥5 paper trade cycles with real whale alerts (not injected)
- [ ] Postgres backup cron configured
- [ ] Flip `PAPER_TRADE = false` in `src/executor/index.ts`
- [ ] Rebuild executor: `docker compose build --no-cache executor && docker compose up -d executor`

---

## Files Modified from Original Spec

| File | Change |
|---|---|
| `src/crawler/index.ts` | NEW — whale discovery crawler |
| `src/whitelist/feeder.ts` | Added `inlineStats` param, removed sharpeRatio gate, threshold $5k→$3k |
| `src/whitelist/server.ts` | Passes `stats` body to feeder |
| `src/executor/index.ts` | Fixed Telegram markdown error in paper trade confirmation |
| `docker-compose.yml` | Added `crawler` service |
| `package.json` | Added `tslib` dep, added `crawler` script |

---

## Useful Commands

```bash
# Check all services
cd ~/copybot && docker compose ps

# Restart listener to pick up new whales
docker compose restart listener

# Check crawler found whales
docker compose logs --tail=30 crawler

# Check whitelist DB
docker compose exec postgres psql -U bot -d copybot -c "SELECT address, score, win_rate, avg_bet_size FROM whitelist;"

# Check open positions
docker compose exec postgres psql -U bot -d copybot -c "SELECT * FROM positions WHERE closed_at IS NULL;"

# Inject test trade (correct payload format)
docker compose exec redis redis-cli PUBLISH approved_trade '{"trade":{"usdcAmount":"500","shares":"909.09","maker":"0xefbc5fec8d7b0acdc8911bdd9a98d6964308f9a2","side":"BUY"},"isHighConviction":true,"market":{"slug":"test-market","question":"Test?"},"daysToResolve":7,"walletBalance":10000,"positionPct":0.05,"positionUSDC":500,"estimatedFillPrice":0.552,"slippagePct":0.4}'

# Force crawler run immediately (restart resets the interval)
docker compose restart crawler

# Full rebuild of a service
docker compose build --no-cache <service> && docker compose up -d <service>
```
