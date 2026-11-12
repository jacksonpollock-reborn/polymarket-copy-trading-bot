import { redisSub, redis } from '../lib/redis';
import { clobClient } from '../lib/polymarket';
import { gammaClient } from '../lib/gamma';
import { db } from '../lib/db';
import 'dotenv/config';

const CONFIG = {
  MIN_PRICE: 0.10,
  MAX_PRICE: 0.85,
  MAX_SLIPPAGE_PCT: 15,
  MAX_DAYS_TO_RESOLVE: 45,
  POSITION_PCT_DEFAULT: 0.20,
  POSITION_PCT_HIGH_CONVICTION: 0.30,
  PAPER_TRADE_BALANCE: 1000,   // simulated USDC balance when real balance is 0
  DEDUP_WINDOW_MS: 5 * 60_000, // ignore same whale+token within 5 min
};

// Dedup: track recently approved whale+token pairs
const recentlyApproved = new Map<string, number>();

interface OrderbookLevel {
  price: number;
  size: number;
}

function simulateSlippage(asks: OrderbookLevel[], usdcSize: number, currentPrice: number): number {
  // Edge case: empty book or zero position
  if (!asks.length || usdcSize <= 0) return 0;

  let remainingUSDC = usdcSize;
  let totalUSDCSpent = 0;
  let totalSharesReceived = 0;

  for (const level of asks) {
    if (level.price <= 0 || level.size <= 0) continue;
    const levelUSDC = level.price * level.size;           // max USDC this level can absorb
    const fillUSDC = Math.min(remainingUSDC, levelUSDC);  // USDC we spend here
    const fillShares = fillUSDC / level.price;            // shares we receive here

    totalUSDCSpent += fillUSDC;
    totalSharesReceived += fillShares;
    remainingUSDC -= fillUSDC;
    if (remainingUSDC <= 0) break;
  }

  // If book is too thin to fill any shares, treat as infinite slippage
  if (totalSharesReceived <= 0) return Infinity;

  // True average fill price = total USDC paid / total shares received
  const avgFillPrice = totalUSDCSpent / totalSharesReceived;

  console.log(`[slippage-debug] currentPrice=${currentPrice.toFixed(4)} avgFill=${avgFillPrice.toFixed(4)} posUSDC=${usdcSize} sharesReceived=${totalSharesReceived.toFixed(2)} bookDepth=${asks.length} levels unfilled=${remainingUSDC.toFixed(2)} USDC`);

  return ((avgFillPrice - currentPrice) / currentPrice) * 100;
}

async function getInsiderTrackerAlert(conditionId: string): Promise<boolean> {
  try {
    const res = await db.query(
      `SELECT 1 FROM tracker_alerts WHERE condition_id = $1 AND alert_type IN ('ALERT_SMURF_DETECTED', 'COORDINATED_SWARM_HOURS') AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [conditionId]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

redisSub.subscribe('raw_trade', (err) => {
  if (err) console.error('Subscribe error:', err);
  console.log('Filter listening on raw_trade...');
});

redisSub.on('message', async (_channel, message) => {
  const trade = JSON.parse(message);

  if (trade.side !== 'BUY') {
    await redis.publish('raw_trade_sell', message);
    return;
  }

  try {
    const marketMeta = await gammaClient.getMarket(trade.tokenId);
    if (!marketMeta) { console.log('SKIP: Market not found'); return; }

    const whaleFillPrice = parseFloat(trade.usdcAmount) / parseFloat(trade.shares);

    // Price range check uses whale's actual fill price
    if (whaleFillPrice < CONFIG.MIN_PRICE || whaleFillPrice > CONFIG.MAX_PRICE) {
      console.log(`SKIP: Price $${whaleFillPrice.toFixed(3)} out of range`); return;
    }

    const daysToResolve = (new Date(marketMeta.endDate).getTime() - Date.now()) / 86400000;
    if (daysToResolve > CONFIG.MAX_DAYS_TO_RESOLVE) {
      console.log(`SKIP: Resolves in ${Math.round(daysToResolve)} days`); return;
    }

    // Dedup: skip if same whale+token was approved in the last 5 min
    const dedupKey = `${trade.maker}:${trade.tokenId}`;
    const lastApproved = recentlyApproved.get(dedupKey) ?? 0;
    if (Date.now() - lastApproved < CONFIG.DEDUP_WINDOW_MS) {
      console.log(`SKIP: dedup — ${trade.maker.slice(0,8)} already approved for this token within 5min`);
      return;
    }

    const [orderbook, balanceData] = await Promise.all([
      clobClient.getOrderBook(trade.tokenId),
      clobClient.getBalanceAllowance({ asset_type: 'USDC' } as any),
    ]);

    // Use paper trade fallback balance if real balance is 0 (no live USDC yet)
    const rawBalance = parseFloat((balanceData as any).balance || '0');
    const walletBalance = rawBalance > 0 ? rawBalance : CONFIG.PAPER_TRADE_BALANCE;
    const hasAlert = await getInsiderTrackerAlert(marketMeta.conditionId);
    const positionPct = hasAlert ? CONFIG.POSITION_PCT_HIGH_CONVICTION : CONFIG.POSITION_PCT_DEFAULT;
    const positionUSDC = walletBalance * positionPct;

    const asks: OrderbookLevel[] = (orderbook.asks || []).map((a: any) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    // Guard: if best ask ≥ $0.95 the orderbook has no real liquidity (maker-consumed / stubs only)
    const bestAsk = asks.length > 0 ? asks[0].price : 1.0;
    if (bestAsk >= 0.95) {
      console.log(`SKIP: No real ask liquidity (bestAsk=$${bestAsk.toFixed(3)}) — maker-consumed orderbook`);
      return;
    }

    // Use gamma mid-price as slippage baseline (authoritative current market price)
    // Fall back to whale fill price if gamma didn't return a valid mid-price
    const currentPrice = marketMeta.midPrice > 0 ? marketMeta.midPrice : whaleFillPrice;

    const slippagePct = simulateSlippage(asks, positionUSDC, currentPrice);

    if (slippagePct > CONFIG.MAX_SLIPPAGE_PCT) {
      console.log(`SKIP: Slippage ${slippagePct.toFixed(1)}% exceeds limit`); return;
    }

    const approved = {
      trade,
      market: marketMeta,
      positionUSDC,
      positionPct,
      estimatedFillPrice: currentPrice * (1 + slippagePct / 100),
      slippagePct,
      walletBalance,
      isHighConviction: hasAlert,
      daysToResolve: Math.round(daysToResolve),
    };

    recentlyApproved.set(dedupKey, Date.now());
    await redis.publish('approved_trade', JSON.stringify(approved));
    console.log(`[APPROVED] ${marketMeta.question} — $${positionUSDC} @ slippage ${slippagePct.toFixed(1)}%`);

  } catch (e: any) {
    console.error('Filter error:', e.message);
  }
});
