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
      await bot.telegram.sendMessage(CHAT_ID, `📝 PAPER TRADE\n$${data.positionUSDC} @ $${data.estimatedFillPrice.toFixed(3)}\nSet PAPER_TRADE=false to go live.`);
      return;
    }

    const order = await clobClient.createOrder({
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
