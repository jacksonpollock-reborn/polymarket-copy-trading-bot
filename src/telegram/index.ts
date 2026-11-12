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
