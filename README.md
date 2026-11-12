# polymarket-copy-trading-bot

A paper-first Polymarket copy-trading pipeline: discover profitable "whale" wallets, watch their on-chain fills, and send you a Telegram alert with a one-tap confirm button.

## Overview

Copying a good Polymarket trader is mostly a plumbing problem: find wallets worth following, notice their trades quickly, decide whether the trade is still attractive at your price, and size it sensibly. This project splits that into small TypeScript services that talk over Redis pub/sub and share a Postgres database, all started with Docker Compose.

A crawler builds a whitelist of wallets from the public Polymarket leaderboard. A listener polls the Polygon CTF Exchange for `OrderFilled` events from whitelisted wallets. A filter checks price, time to resolution and order-book slippage and sizes the trade. A Telegram bot asks you to approve it. The executor then places the order, or, in the default paper mode, only logs it.

## Features

- Automated whale discovery from the Polymarket data API (leaderboard, activity), re-run every 3 hours.
- Whitelist stored in Postgres and exposed through a small authenticated HTTP endpoint.
- On-chain detection of whitelisted wallets' fills on the Polymarket CTF Exchange (HTTP polling, Free-tier-friendly).
- Trade filter: price band, days to resolution, simulated slippage against the live order book, duplicate suppression.
- Position sizing as a percentage of balance, larger when an external "tracker" anomaly alert is present.
- Human-in-the-loop execution through Telegram (execute / pass buttons, 10 minute expiry).
- Risk manager that mirrors whale exits proportionally and warns about decaying positions.
- Paper-trade mode on by default.

## Architecture

```
 Polymarket data API
        |
    [crawler] --POST /whitelist/evaluate--> [whitelist server :3000] --> Postgres: whitelist
                                                                              |
 Polygon RPC --> [listener] --loads-----------------------------------------+
                     |
                     v  Redis: raw_trade
                 [filter]  -- SELL --> Redis: raw_trade_sell --> [risk]
                     |
                     v  Redis: approved_trade
                [telegram bot]  -- you tap EXECUTE --> Redis: execute_trade
                                                             |
                                                             v
                                                        [executor]  (paper: log only / live: CLOB order)
                                                             |
                                                             v
                                                    Postgres: positions
```

Nine containers in total: `postgres`, `redis`, `listener`, `filter`, `telegram`, `executor`, `risk`, `whitelist`, `crawler`.

### What each service does

| Service | Source | Behaviour |
|---|---|---|
| crawler | `src/crawler/index.ts` | Every 3 h pulls the all-time and monthly leaderboard (top 100 each). Keeps wallets with PnL > 0, volume >= $50k, ROI >= 10%, average entry price 0.15 to 0.80 and average bet >= $1,500, then submits them to the whitelist server. |
| whitelist | `src/whitelist/` | Express server on port 3000. `POST /whitelist/evaluate` (header `x-api-key`) applies the final thresholds (win rate >= 0.60, average bet >= $1,500) and upserts into Postgres. |
| listener | `src/listener/index.ts` | Polls Polygon every 30 s for `OrderFilled` events on the CTF Exchange, keeps events whose maker is whitelisted, snapshots the wallet's share balance, publishes to `raw_trade`. Reloads the whitelist hourly. |
| filter | `src/filter/index.ts` | Routes SELLs to the risk manager. For BUYs: price 0.10 to 0.85, resolves within 45 days, simulated slippage <= 15%, 5 minute de-duplication. Sizes at 20% of balance (30% for high conviction). Uses a $1,000 simulated balance when the real balance is 0. |
| telegram | `src/telegram/index.ts` | Sends the alert with EXECUTE / PASS buttons; pending trades expire after 10 minutes. |
| executor | `src/executor/index.ts` | `PAPER_TRADE = true` by default: logs and notifies only. When flipped to false, signs and posts a fill-or-kill order through `@polymarket/clob-client` and records the position. |
| risk | `src/risk/index.ts` | Mirrors a whale's sell proportionally against open positions; every 30 s warns if a position is down more than 40% with under 24 h to resolution. |

## Tech stack

TypeScript (Node 20), ethers v6, `@polymarket/clob-client`, Telegraf, ioredis, pg, Express, Redis 7, Postgres 16, Docker Compose.

## Project structure

```
src/
  crawler/        Whale discovery from the leaderboard / activity API
  whitelist/      Whitelist HTTP server and threshold logic
  listener/       Polygon CTF Exchange event poller
  filter/         Price, timing, slippage and sizing checks
  telegram/       Alert + confirm bot
  executor/       Paper / live order execution
  risk/           Exit mirroring and decay warnings
  lib/            Shared clients (Postgres, Redis, CLOB, Gamma API)
docker/init.sql   Postgres schema (whitelist, positions)
docker-compose.yml, Dockerfile
SYSTEM_SUMMARY.md Longer system notes (some numbers there predate the code; trust the source)
polymarket_bot_spec.md  Original build spec
.env.example      Placeholder configuration
```

## Setup

Prerequisites: Docker with Compose, Node.js 20 (only for local builds), a Polygon RPC endpoint (for example an Alchemy app), a Telegram bot token and chat id, and Polymarket CLOB API credentials for the wallet you intend to use.

```bash
git clone <this-repo> && cd polymarket-copy-trading-bot
cp .env.example .env      # then fill in every value
npm install               # optional: only needed for local type-checking
npm run build             # compiles TypeScript to dist/ (optional locally; the Dockerfile does it too)
docker compose up -d --build
```

The Postgres schema in `docker/init.sql` is applied automatically the first time the database volume is created.

## Configuration

All services read configuration from `.env` (see `.env.example`):

| Variable | Used by | Purpose |
|---|---|---|
| `WALLET_PRIVATE_KEY` | executor, risk | Signs CLOB orders. Loaded at start-up by anything importing `lib/polymarket.ts`, so it must be a valid key even in paper mode |
| `CLOB_API_KEY`, `CLOB_API_SECRET`, `CLOB_API_PASSPHRASE` | executor, risk | Polymarket CLOB API credentials |
| `POLYGON_WSS_RPC` | listener | Polygon RPC URL (`wss://` is rewritten to `https://`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | telegram, executor, risk | Alerts and confirmation buttons |
| `INTERNAL_API_KEY` | whitelist, crawler | Shared secret for `POST /whitelist/evaluate` |
| `DATABASE_URL` | all DB users | Postgres connection string |
| `REDIS_URL` | all | Redis connection string |
| `WHITELIST_URL` | crawler | Defaults to `http://whitelist:3000` |

Strategy thresholds (price band, slippage, sizing, crawl interval, stop-loss) are constants at the top of the relevant source files. `PAPER_TRADE` is a constant in `src/executor/index.ts`, not an environment variable.

## Usage

```bash
docker compose ps                         # service status
docker compose logs -f listener filter    # follow detection and filtering
docker compose logs --tail=30 crawler     # see which wallets qualified
docker compose restart listener           # force an immediate whitelist reload

# inspect the whitelist and open positions
docker compose exec postgres psql -U bot -d copybot -c "SELECT address, score, win_rate, avg_bet_size FROM whitelist;"
docker compose exec postgres psql -U bot -d copybot -c "SELECT * FROM positions WHERE closed_at IS NULL;"
```

Individual services can also be run from the compiled output, for example `npm run listener` or `npm run crawler`.

## Status and limitations

- Paper-trade mode by default. Going live means editing `PAPER_TRADE` in `src/executor/index.ts` and rebuilding the executor, and has not been battle-tested.
- The filter's "high conviction" check and the whitelist's DB fallback read `tracker_alerts` and `tracker_wallet_stats` tables that belong to a separate tracker project and are not created by `init.sql`; without them the checks quietly return false / no data.
- The crawler uses ROI as a proxy for win rate because the public API does not expose a reliable one.
- The risk manager's exit path calls the CLOB client directly and is not gated by paper mode.
- The default Postgres password in `docker-compose.yml` is for local use only; change it and do not expose the database or port 3000 publicly.
- No automated tests.

## Disclaimer

This project is for research and educational purposes only and is not financial advice. Prediction-market trading can lose money, and copying other traders offers no guarantee of similar results. Use at your own risk; the authors accept no liability for any losses.
