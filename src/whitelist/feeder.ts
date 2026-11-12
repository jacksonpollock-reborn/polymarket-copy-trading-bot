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

export async function evaluateWalletForWhitelist(
  wallet: string,
  score: number,
  marketCount: number,
  inlineStats?: Partial<WalletStats>
) {
  if (score < 80 || marketCount < 3) return;

  // Use inline stats from crawler if provided; fall back to DB lookup
  let stats: WalletStats | null = inlineStats
    ? {
        winRate:         inlineStats.winRate         ?? 0,
        resolvedMarkets: inlineStats.resolvedMarkets ?? marketCount,
        avgBetSize:      inlineStats.avgBetSize      ?? 0,
        sharpeRatio:     inlineStats.sharpeRatio     ?? 0,
      }
    : await fetchWalletStats(wallet);

  if (!stats) { console.log(`No stats found for ${wallet}`); return; }

  if (
    stats.winRate >= 0.60 &&
    stats.resolvedMarkets >= 20 &&
    stats.avgBetSize >= 1500
  ) {
    await db.query(`
      INSERT INTO whitelist (address, score, win_rate, avg_bet_size, sharpe, added_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (address) DO UPDATE SET score = $2, updated_at = NOW()
    `, [wallet.toLowerCase(), score, stats.winRate, stats.avgBetSize, stats.sharpeRatio ?? 0]);

    console.log(`✅ Whitelisted: ${wallet} (score: ${score}, WR: ${stats.winRate}, markets: ${stats.resolvedMarkets})`);
  } else {
    console.log(`❌ ${wallet} failed threshold checks`, stats);
  }
}
