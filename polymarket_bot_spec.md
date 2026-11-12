# Polymarket Copy Trading Bot — Full Spec

## INSTRUCTIONS FOR COWORK
Build and deploy this bot end-to-end starting from Phase 3. The user has already completed:
- Phase 1: Server provisioned
- Phase 2: All API keys obtained (Alchemy WSS RPC, Polymarket CLOB credentials, Telegram bot token + chat ID)

Your job: create all files, install dependencies, build, and deploy via Docker. Ask the user for their .env values when needed. Do not skip steps.

---

## Architecture Overview

5 microservices communicating via Redis pub/sub, backed by Postgres.

```
[Chain Listener] → Redis → [Trade Filter] → Redis → [Telegram Bot]
                                                           ↓ callback
[Execution Engine] ← Redis ←──────────────────────────────┘
      ↓
[Risk Manager] (runs independently, polls positions)
```

Stack: TypeScript + Node.js, PostgreSQL, Redis, ethers.js, @polymarket/clob-client, Telegraf

---

## Phase 3: Project Setup

### Directory Structure
```
~/copybot/
├── src/
│   ├── listener/index.ts
│   ├── filter/index.ts
│   ├── telegram/index.ts
│   ├── executor/index.ts
│   ├── risk/index.ts
│   ├── whitelist/
│   │   ├── feeder.ts
│   │   └── server.ts
│   └── lib/
│       ├── redis.ts
│       ├── db.ts
│       ├── polymarket.ts
│       └── gamma.ts
├── docker/
│   └── init.sql
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env
```

### package.json
```json
{
  "name": "polymarket-copybot",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "listener": "node dist/listener/index.js",
    "filter": "node dist/filter/index.js",
    "telegram": "node dist/telegram/index.js",
    "executor": "node dist/executor/index.js",
    "risk": "node dist/risk/index.js"
  },
  "dependencies": {
    "@polymarket/clob-client": "^3.0.0",
    "ethers": "^6.0.0",
    "telegraf": "^4.15.0",
    "ioredis": "^5.3.0",
    "pg": "^8.11.0",
    "nanoid": "^3.3.7",
    "dotenv": "^16.3.0",
    "express": "^4.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.10.0",
    "@types/express": "^4.17.0",
    "typescript": "^5.3.0"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### .env (populate with user's real values)
```
POLYGON_WSS_RPC=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
WALLET_PRIVATE_KEY=0x...
CLOB_API_KEY=...
CLOB_API_SECRET=...
CLOB_API_PASSPHRASE=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DATABASE_URL=postgresql://bot:botpass@postgres:5432/copybot
REDIS_URL=redis://redis:6379
INTERNAL_API_KEY=...
```

---

## Phase 4: Shared Libraries

### src/lib/redis.ts
```typescript
import Redis from 'ioredis';
import 'dotenv/config';

export const redis = new Redis(process.env.REDIS_URL!);
export const redisSub = new Redis(process.env.REDIS_URL!);
```

### src/lib/db.ts
```typescript
import { Pool } from 'pg';
import 'dotenv/config';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function getWhitelist(): Promise<Set<string>> {
  const res = await db.query('SELECT address FROM whitelist');
  return new Set(res.rows.map(r => r.address.toLowerCase()));
}
```

### src/lib/polymarket.ts
```typescript
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import 'dotenv/config';

const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY!);

export const clobClient = new ClobClient(
  'https://clob.polymarket.com',
  137,
  wallet,
  {
    key: process.env.CLOB_API_KEY!,
    secret: process.env.CLOB_API_SECRET!,
    passphrase: process.env.CLOB_API_PASSPHRASE!,
  }
);
```

### src/lib/gamma.ts
```typescript
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export const gammaClient = {
  async getMarket(tokenId: string) {
    const res = await fetch(`${GAMMA_BASE}/markets?clob_token_ids=${tokenId}`);
    const data = await res.json();
    return data[0];
  }
};
```

---

## Phase 5: Module Code

### src/listener/index.ts
```typescript
import { ethers } from 'ethers';
import { redis } from '../lib/redis';
import { getWhitelist } from '../lib/db';
import 'dotenv/config';

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const ORDER_FILLED_TOPIC = ethers.id('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');

const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
];

async function startListener() {
  const provider = new ethers.WebSocketProvider(process.env.POLYGON_WSS_RPC!);
  const whitelist = await getWhitelist();

  console.log(`Listener started. Watching ${whitelist.size} whitelisted wallets.`);

  const filter = {
    address: CTF_EXCHANGE,
    topics: [ORDER_FILLED_TOPIC],
  };

  provider.on(filter, async (log) => {
    try {
      const iface = new ethers.Interface(CTF_EXCHANGE_ABI);
      const decoded = iface.parseLog(log);
      if (!decoded) return;

      const maker = decoded.args.maker.toLowerCase();
      if (!whitelist.has(maker)) return;

      const tokenId = decoded.args.makerAssetId.toString();
      const side = decoded.args.makerAssetId > decoded.args.takerAssetId ? 'BUY' : 'SELL';
      const usdcAmount = ethers.formatUnits(decoded.args.takerAmountFilled, 6);
      const shares = ethers.formatUnits(decoded.args.makerAmountFilled, 6);

      // IMPORTANT: snapshot whale's TOTAL balance (not just this tx)
      const ctfContract = new ethers.Contract(
        CTF_EXCHANGE,
        ['function balanceOf(address account, uint256 id) view returns (uint256)'],
        provider
      );
      const whaleBalance = await ctfContract.balanceOf(maker, tokenId);
      const whaleSharesTotal = ethers.formatUnits(whaleBalance, 6);

      const payload = {
        maker,
        tokenId,
        side,
        usdcAmount,
        shares,
        whaleSharesTotal, // used for proportional exit math
        txHash: log.transactionHash,
        detectedAt: Date.now(),
      };

      await redis.publish('raw_trade', JSON.stringify(payload));
      console.log(`[DETECTED] ${side} by ${maker.slice(0, 8)}... $${usdcAmount} USDC`);

    } catch (e: any) {
      console.error('Parse error:', e.message);
    }
  });

  provider.on('error', (e) => {
    console.error('Provider error, reconnecting in 5s:', e.message);
    setTimeout(startListener, 5000);
  });
}

startListener();
```

### src/filter/index.ts
```typescript
import { redisSub, redis } from '../lib/redis';
import { clobClient } from '../lib/polymarket';
import { gammaClient } from '../lib/gamma';
import { db } from '../lib/db';
import 'dotenv/config';

const CONFIG = {
  MIN_PRICE: 0.10,
  MAX_PRICE: 0.85,
  MAX_SLIPPAGE_PCT: 3,
  MAX_DAYS_TO_RESOLVE: 45,
  POSITION_PCT_DEFAULT: 0.20,
  POSITION_PCT_HIGH_CONVICTION: 0.30,
};

interface OrderbookLevel {
  price: number;
  size: number;
}

function simulateSlippage(asks: OrderbookLevel[], usdcSize: number, currentPrice: number): number {
  let remaining = usdcSize;
  let totalCost = 0;

  for (const level of asks) {
    const levelCost = level.price * level.size;
    const fill = Math.min(remaining, levelCost);
    totalCost += fill;
    remaining -= fill;
    if (remaining <= 0) break;
  }

  const avgPrice = usdcSize > 0 ? totalCost / usdcSize : currentPrice;
  return ((avgPrice - currentPrice) / currentPrice) * 100;
}

async function getInsiderTrackerAlert(conditionId: string): Promise<boolean> {
  // Query your existing tracker DB for active anomaly alerts on this market
  // Returns true if ALERT_SMURF_DETECTED or COORDINATED_SWARM_HOURS is active
  try {
    const res = await db.query(
      `SELECT 1 FROM tracker_alerts WHERE condition_id = $1 AND alert_type IN ('ALERT_SMURF_DETECTED', 'COORDINATED_SWARM_HOURS') AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [conditionId]
    );
    return res.rows.length > 0;
  } catch {
    return false; // tracker table may not exist yet
  }
}

redisSub.subscribe('raw_trade', (err) => {
  if (err) console.error('Subscribe error:', err);
  console.log('Filter listening on raw_trade...');
});

redisSub.on('message', async (_channel, message) => {
  const trade = JSON.parse(message);

  if (trade.side !== 'BUY') {
    // SELL events go straight to risk manager — don't filter them
    await redis.publish('raw_trade_sell', message);
    return;
  }

  try {
    const marketMeta = await gammaClient.getMarket(trade.tokenId);
    if (!marketMeta) { console.log('SKIP: Market not found'); return; }

    const price = parseFloat(trade.usdcAmount) / parseFloat(trade.shares);

    if (price < CONFIG.MIN_PRICE || price > CONFIG.MAX_PRICE) {
      console.log(`SKIP: Price $${price.toFixed(3)} out of range`); return;
    }

    const daysToResolve = (new Date(marketMeta.endDate).getTime() - Date.now()) / 86400000;
    if (daysToResolve > CONFIG.MAX_DAYS_TO_RESOLVE) {
      console.log(`SKIP: Resolves in ${Math.round(daysToResolve)} days`); return;
    }

    const [orderbook, balanceData] = await Promise.all([
      clobClient.getOrderBook(trade.tokenId),
      clobClient.getBalanceAllowance({ asset_type: 'USDC' } as any),
    ]);

    const walletBalance = parseFloat((balanceData as any).balance || '0');
    const hasAlert = await getInsiderTrackerAlert(marketMeta.conditionId);
    const positionPct = hasAlert ? CONFIG.POSITION_PCT_HIGH_CONVICTION : CONFIG.POSITION_PCT_DEFAULT;
    const positionUSDC = walletBalance * positionPct;

    const asks: OrderbookLevel[] = (orderbook.asks || []).map((a: any) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    const slippagePct = simulateSlippage(asks, positionUSDC, price);

    if (slippagePct > CONFIG.MAX_SLIPPAGE_PCT) {
      console.log(`SKIP: Slippage ${slippagePct.toFixed(1)}% exceeds limit`); return;
    }

    const approved = {
      trade,
      market: marketMeta,
      positionUSDC,
      positionPct,
      estimatedFillPrice: price * (1 + slippagePct / 100),
      slippagePct,
      walletBalance,
      isHighConviction: hasAlert,
      daysToResolve: Math.round(daysToResolve),
    };

    await redis.publish('approved_trade', JSON.stringify(approved));
    console.log(`[APPROVED] ${marketMeta.question} — $${positionUSDC} @ slippage ${slippagePct.toFixed(1)}%`);

  } catch (e: any) {
    console.error('Filter error:', e.message);
  }
});
```

### src/telegram/index.ts
```typescript
import { Telegraf, Markup } from 'telegraf';
import { redisSub, redis } from '../lib/redis';
import { nanoid } from 'nanoid';
import 'dotenv/config';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const pendingTrades = new Map<string, any>();

redisSub.subscribe('approved_trade', (err) => {
  if (err) console.error('Subscribe error:', err);
  console.log('Telegram bot listening for approved trades...');
});

redisSub.on('message', async (_channel, message) => {
  const data = JSON.parse(message);
  const tradeId = nanoid(8);
  pendingTrades.set(tradeId, data);
  setTimeout(() => pendingTrades.delete(tradeId), 600_000);

  const price = (parseFloat(data.trade.usdcAmount) / parseFloat(data.trade.shares)).toFixed(3);
  const convictionTag = data.isHighConviction
    ? '\n🔥 *HIGH CONVICTION* — Tracker active anomaly alert'
    : '';
  const whaleShort = `${data.trade.maker.slice(0, 6)}...${data.trade.maker.slice(-4)}`;
  const whaleProfile = `https://polymarket.com/profile/${data.trade.maker}`;
  const marketLink = `https://polymarket.com/event/${data.market.slug}`;

  const msg = `
🚨 *WHITELIST TRIGGER*${convictionTag}

*Wallet:* \`${whaleShort}\`
*Market:* ${data.market.question}
*Action:* Bought ${data.trade.side} at $${price} (Size: $${parseFloat(data.trade.usdcAmount).toLocaleString()})
*Resolves:* ${data.daysToResolve} days
[Whale Profile](${whaleProfile}) | [Market](${marketLink})

📊 *YOUR EXECUTION DATA*
*Available Balance:* $${data.walletBalance.toLocaleString()} USDC
*Calculated Position (${Math.round(data.positionPct * 100)}%):* $${data.positionUSDC.toLocaleString()} USDC
*Est. Fill Price:* $${data.estimatedFillPrice.toFixed(3)} (Slippage: ${data.slippagePct.toFixed(1)}%)
`.trim();

  await bot.telegram.sendMessage(CHAT_ID, msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      Markup.button.callback('✅ EXECUTE TRADE', `exec_${tradeId}`),
      Markup.button.callback('❌ PASS', `pass_${tradeId}`),
    ]),
  });
});

bot.action(/exec_(.+)/, async (ctx) => {
  const tradeId = ctx.match[1];
  const trade = pendingTrades.get(tradeId);
  if (!trade) return ctx.editMessageText('⚠️ Trade expired or already actioned.');
  pendingTrades.delete(tradeId);
  await redis.publish('execute_trade', JSON.stringify(trade));
  await ctx.editMessageText(`⏳ Executing $${trade.positionUSDC.toLocaleString()} position...`);
});

bot.action(/pass_(.+)/, async (ctx) => {
  const tradeId = ctx.match[1];
  pendingTrades.delete(tradeId);
  await ctx.editMessageText('⏭️ Passed.');
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

### src/executor/index.ts
```typescript
import { redisSub } from '../lib/redis';
import { clobClient } from '../lib/polymarket';
import { db } from '../lib/db';
import { Telegraf } from 'telegraf';
import 'dotenv/config';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// SET TO TRUE FOR PAPER TRADING — flip to false when ready for real money
const PAPER_TRADE = true;

redisSub.subscribe('execute_trade', (err) => {
  if (err) console.error('Subscribe error:', err);
  console.log('Executor ready...');
});

redisSub.on('message', async (_channel, message) => {
  const data = JSON.parse(message);

  try {
    if (PAPER_TRADE) {
      console.log('[PAPER TRADE] Would execute:', {
        tokenID: data.trade.tokenId,
        price: data.estimatedFillPrice,
        size: (data.positionUSDC / data.estimatedFillPrice).toFixed(2),
        side: 'BUY',
      });
      await bot.telegram.sendMessage(CHAT_ID, `📝 *PAPER TRADE*\n$${data.positionUSDC} @ $${data.estimatedFillPrice.toFixed(3)}\nSet PAPER_TRADE=false to go live.`, { parse_mode: 'Markdown' });
      return;
    }

    const order = await clobClient.createAndSignOrder({
      tokenID: data.trade.tokenId,
      price: data.estimatedFillPrice,
      size: data.positionUSDC / data.estimatedFillPrice,
      side: 'BUY',
      feeRateBps: 0,
      nonce: 0,
      expiration: 0,
    } as any);

    const resp = await clobClient.postOrder(order as any, 'FOK' as any);

    if ((resp as any).status === 'matched') {
      await db.query(`
        INSERT INTO positions (market_id, token_id, whale_address, entry_price, shares, usdc_spent, whale_shares_at_entry, opened_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        data.market.conditionId,
        data.trade.tokenId,
        data.trade.maker,
        data.estimatedFillPrice,
        (resp as any).size,
        data.positionUSDC,
        data.trade.whaleSharesTotal,
      ]);

      await bot.telegram.sendMessage(CHAT_ID,
        `✅ *EXECUTED*\n$${data.positionUSDC.toLocaleString()} @ $${data.estimatedFillPrice.toFixed(3)}\nTx: \`${(resp as any).transactionHash}\``,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.telegram.sendMessage(CHAT_ID, `⚠️ Order failed: ${(resp as any).errorMsg}`);
    }
  } catch (e: any) {
    console.error('Execution error:', e.message);
    await bot.telegram.sendMessage(CHAT_ID, `🔴 Execution error: ${e.message}`);
  }
});
```

### src/risk/index.ts
```typescript
import { redisSub } from '../lib/redis';
import { clobClient } from '../lib/polymarket';
import { db } from '../lib/db';
import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const STOP_LOSS_DROP_PCT = 40;
const DECAY_WINDOW_HOURS = 24;
const TVL_DROP_THRESHOLD_PCT = 30;

// Mirror whale exits
redisSub.subscribe('raw_trade_sell', (err) => {
  if (err) console.error('Subscribe error:', err);
});

redisSub.on('message', async (_channel, message) => {
  const trade = JSON.parse(message);
  if (trade.side !== 'SELL') return;

  const position = await db.query(`
    SELECT * FROM positions
    WHERE whale_address = $1 AND token_id = $2 AND closed_at IS NULL
  `, [trade.maker, trade.tokenId]);

  if (!position.rows.length) return;

  const pos = position.rows[0];
  const whaleSellRatio = parseFloat(trade.shares) / parseFloat(pos.whale_shares_at_entry);
  const ourSellShares = parseFloat(pos.shares) * whaleSellRatio;

  await executeExit(pos, ourSellShares, `Whale exited ${Math.round(whaleSellRatio * 100)}%`);
});

async function executeExit(pos: any, sharesToSell: number, reason: string) {
  try {
    const order = await clobClient.createAndSignOrder({
      tokenID: pos.token_id,
      price: 0, // market order
      size: sharesToSell,
      side: 'SELL',
      feeRateBps: 0,
      nonce: 0,
      expiration: 0,
    } as any);

    const resp = await clobClient.postOrder(order as any, 'FOK' as any);
    const exitPrice = (resp as any).price || 0;
    const pnl = (exitPrice - pos.entry_price) * sharesToSell;

    await db.query(`
      UPDATE positions SET closed_at = NOW(), exit_price = $1, pnl_usdc = $2
      WHERE id = $3
    `, [exitPrice, pnl, pos.id]);

    await bot.telegram.sendMessage(CHAT_ID,
      `🔄 *AUTO EXIT*\nReason: ${reason}\nShares sold: ${sharesToSell.toFixed(2)}\nPnL: $${pnl.toFixed(2)}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e: any) {
    console.error('Exit error:', e.message);
  }
}

async function runFailsafeChecks() {
  const positions = await db.query(`SELECT * FROM positions WHERE closed_at IS NULL`);

  for (const pos of positions.rows) {
    try {
      const marketData = await clobClient.getMarket(pos.token_id) as any;
      const currentPrice = parseFloat(marketData.bestAsk || marketData.best_ask || pos.entry_price);
      const dropPct = ((pos.entry_price - currentPrice) / pos.entry_price) * 100;
      const hoursToResolve = (new Date(marketData.endDate || marketData.end_date_iso).getTime() - Date.now()) / 3600000;

      if (hoursToResolve < DECAY_WINDOW_HOURS && dropPct > STOP_LOSS_DROP_PCT) {
        await bot.telegram.sendMessage(CHAT_ID,
          `⏰ *POSITION DECAYING*\nMarket resolves in ${hoursToResolve.toFixed(1)}h\nDown ${dropPct.toFixed(1)}% from entry\nCut losses?`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              Markup.button.callback('✅ EXIT NOW', `exit_${pos.id}`),
              Markup.button.callback('❌ HOLD', `hold_${pos.id}`),
            ]),
          }
        );
      }
    } catch (e: any) {
      console.error(`Failsafe check error for position ${pos.id}:`, e.message);
    }
  }
}

setInterval(runFailsafeChecks, 30_000);
console.log('Risk manager running...');
```

### src/whitelist/feeder.ts
```typescript
import { db } from '../lib/db';

interface WalletStats {
  winRate: number;
  resolvedMarkets: number;
  avgBetSize: number;
  sharpeRatio: number;
}

async function fetchWalletStats(wallet: string): Promise<WalletStats | null> {
  // Pull from your existing tracker DB tables
  // Adjust table/column names to match your tracker schema
  try {
    const res = await db.query(`
      SELECT win_rate, resolved_markets, avg_bet_size, sharpe_ratio
      FROM tracker_wallet_stats WHERE address = $1
    `, [wallet]);
    return res.rows[0] || null;
  } catch {
    return null;
  }
}

export async function evaluateWalletForWhitelist(wallet: string, score: number, marketCount: number) {
  if (score < 80 || marketCount < 3) return;

  const stats = await fetchWalletStats(wallet);
  if (!stats) { console.log(`No stats found for ${wallet}`); return; }

  if (
    stats.winRate >= 0.60 &&
    stats.resolvedMarkets >= 20 &&
    stats.avgBetSize >= 5000 &&
    stats.sharpeRatio >= 1.2
  ) {
    await db.query(`
      INSERT INTO whitelist (address, score, win_rate, avg_bet_size, sharpe, added_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (address) DO UPDATE SET score = $2, updated_at = NOW()
    `, [wallet.toLowerCase(), score, stats.winRate, stats.avgBetSize, stats.sharpeRatio]);

    console.log(`✅ Whitelisted: ${wallet} (score: ${score}, WR: ${stats.winRate})`);
  } else {
    console.log(`❌ ${wallet} failed Layer 1 checks`, stats);
  }
}
```

### src/whitelist/server.ts
```typescript
import express from 'express';
import { evaluateWalletForWhitelist } from './feeder';
import 'dotenv/config';

const app = express();
app.use(express.json());

app.post('/whitelist/evaluate', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { wallet, score, marketCount } = req.body;
  await evaluateWalletForWhitelist(wallet, score, marketCount);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Whitelist server on port 3000'));
```

---

## Phase 5: Docker

### Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build
RUN npm prune --production
```

### docker-compose.yml
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: copybot
      POSTGRES_USER: bot
      POSTGRES_PASSWORD: botpass
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init.sql:/docker-entrypoint-initdb.d/init.sql
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  listener:
    build: .
    command: node dist/listener/index.js
    env_file: .env
    depends_on: [redis, postgres]
    restart: unless-stopped

  filter:
    build: .
    command: node dist/filter/index.js
    env_file: .env
    depends_on: [redis, postgres]
    restart: unless-stopped

  telegram:
    build: .
    command: node dist/telegram/index.js
    env_file: .env
    depends_on: [redis]
    restart: unless-stopped

  executor:
    build: .
    command: node dist/executor/index.js
    env_file: .env
    depends_on: [redis, postgres]
    restart: unless-stopped

  risk:
    build: .
    command: node dist/risk/index.js
    env_file: .env
    depends_on: [redis, postgres]
    restart: unless-stopped

  whitelist:
    build: .
    command: node dist/whitelist/server.js
    env_file: .env
    ports:
      - "3000:3000"
    depends_on: [redis, postgres]
    restart: unless-stopped

volumes:
  pgdata:
```

### docker/init.sql
```sql
CREATE TABLE IF NOT EXISTS whitelist (
  address TEXT PRIMARY KEY,
  score NUMERIC,
  win_rate NUMERIC,
  avg_bet_size NUMERIC,
  sharpe NUMERIC,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  market_id TEXT,
  token_id TEXT,
  whale_address TEXT,
  entry_price NUMERIC,
  shares NUMERIC,
  usdc_spent NUMERIC,
  whale_shares_at_entry NUMERIC,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  exit_price NUMERIC,
  pnl_usdc NUMERIC
);

-- Seed a test whale (replace with real address before deploying)
-- INSERT INTO whitelist (address, score, win_rate, avg_bet_size, sharpe)
-- VALUES ('0xyourwhaleaddress', 90, 0.72, 8000, 1.8);
```

---

## Phase 6: Build & Deploy Commands

```bash
# 1. Install deps
npm install

# 2. Build TypeScript
npm run build

# 3. Start all services
docker compose up -d

# 4. Check logs
docker compose logs -f

# 5. Verify DB tables exist
docker compose exec postgres psql -U bot -d copybot -c "\dt"

# 6. Seed a test whale
docker compose exec postgres psql -U bot -d copybot -c "
INSERT INTO whitelist (address, score, win_rate, avg_bet_size, sharpe)
VALUES ('0xREALWHALEADDRESS', 90, 0.72, 8000, 1.8);
"

# 7. Test Telegram pipeline (inject fake approved trade)
docker compose exec redis redis-cli publish approved_trade '{
  "trade": {"maker":"0xTest1234","tokenId":"999","side":"BUY","usdcAmount":"12000","shares":"26666","whaleSharesTotal":"26666"},
  "market": {"question":"Will ETH hit 5k?","slug":"eth-5k","conditionId":"0xabc"},
  "positionUSDC":1000,"positionPct":0.20,"estimatedFillPrice":0.46,
  "slippagePct":2.2,"walletBalance":5000,"isHighConviction":false,"daysToResolve":30
}'
```

---

## Phase 7: Go-Live Checklist

- [ ] All .env values populated with real keys
- [ ] `PAPER_TRADE = true` in executor — run at least 5 full cycles before flipping
- [ ] USDC approved on Polymarket CTF contract (do via Polymarket UI)
- [ ] Postgres backup cron set up
- [ ] At least 1 real whale seeded in whitelist table
- [ ] Telegram EXECUTE button tested end-to-end via Redis inject
- [ ] Flip `PAPER_TRADE = false` only after 5 clean paper cycles confirmed

---

## Critical Notes

1. **PAPER_TRADE flag** — executor/index.ts has `const PAPER_TRADE = true` by default. Do not flip until you've verified end-to-end flow works.

2. **Whale balance snapshot** — listener calls `balanceOf(whale, tokenId)` on-chain immediately after detecting a buy to get their *total* position, not just this tx's size. This is what makes proportional exits accurate.

3. **Redis channels used:**
   - `raw_trade` — all events from listener
   - `raw_trade_sell` — sell events only (filter routes these to risk manager)
   - `approved_trade` — passed filter checks, waiting for user approval
   - `execute_trade` — user tapped EXECUTE, executor picks up

4. **Polymarket CLOB auth** — run the key generation script on your dev machine once, then paste the 3 values into .env. Keys don't expire.

5. **CTF Exchange address** — `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` on Polygon Mainnet. Verify this is current at https://docs.polymarket.com before deploying.
