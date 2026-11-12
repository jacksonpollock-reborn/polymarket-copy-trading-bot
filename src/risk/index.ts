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
    const order = await clobClient.createOrder({
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
