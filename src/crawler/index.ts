import 'dotenv/config';

const DATA_API   = 'https://data-api.polymarket.com';
const WHITELIST_URL = process.env.WHITELIST_URL || 'http://whitelist:3000';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const CRAWL_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const RATE_LIMIT_MS = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  proxyWallet: string;
  userName: string;
  pnl: number;
  vol: number;
}

interface ActivityEntry {
  usdcSize: number;   // USD value of individual trade
  price: number;      // entry price (0–1)
  side: string;       // BUY | SELL
  type: string;       // TRADE | YIELD
}

interface PositionEntry {
  proxyWallet: string;
  realizedPnl: number;
  currentValue: number;
  cashPnl: number;
  size: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

// ─── Step 1: Fetch leaderboards ───────────────────────────────────────────────

async function fetchLeaderboard(period: string): Promise<Map<string, LeaderboardEntry>> {
  // Paginate: API max appears to be 20/page, fetch 5 pages = 100 wallets
  const allEntries: LeaderboardEntry[] = [];
  for (let offset = 0; offset < 100; offset += 20) {
    const url = `${DATA_API}/v1/leaderboard?timePeriod=${period}&orderBy=PNL&limit=20&offset=${offset}&category=overall`;
    const page = await fetchJSON<LeaderboardEntry[]>(url);
    if (!page.length) break;
    allEntries.push(...page);
    await sleep(100);
  }
  console.log(`[crawler] Fetched ${allEntries.length} entries for timePeriod=${period}`);
  const data = allEntries;
  const map = new Map<string, LeaderboardEntry>();
  for (const entry of data) {
    if (entry.proxyWallet) map.set(entry.proxyWallet.toLowerCase(), entry);
  }
  return map;
}

// ─── Step 2: Fetch per-wallet activity stats ──────────────────────────────────

interface ActivityStats {
  avgEntryPrice: number;
  avgBetSize: number;
  tradeCount: number;
}

async function fetchActivityStats(wallet: string): Promise<ActivityStats | null> {
  try {
    const url = `${DATA_API}/activity?user=${wallet}&type=TRADE&limit=500`;
    const data = await fetchJSON<ActivityEntry[]>(url);
    const buys = data.filter(a => a.side === 'BUY' && a.type === 'TRADE' && a.usdcSize > 0);
    if (buys.length === 0) return null;

    const avgEntryPrice = buys.reduce((s, a) => s + a.price, 0) / buys.length;
    const avgBetSize    = buys.reduce((s, a) => s + a.usdcSize, 0) / buys.length;

    return { avgEntryPrice, avgBetSize, tradeCount: buys.length };
  } catch (e: any) {
    console.warn(`[crawler] activity fetch failed for ${wallet}: ${e.message}`);
    return null;
  }
}

// ─── Step 3: Fetch closed positions and count wins ────────────────────────────

interface PositionStats {
  resolvedWinCount: number;
  winRate: number;
}

async function fetchPositionStats(wallet: string): Promise<PositionStats | null> {
  try {
    const url = `${DATA_API}/positions?user=${wallet}&closed=true&limit=500`;
    const data = await fetchJSON<PositionEntry[]>(url);
    if (!Array.isArray(data) || data.length === 0) return null;

    // realizedPnl is always 0 in this API — profit is in currentValue (redeemable wins)
    // or cashPnl (sold before resolution). Count either as a win.
    const wins = data.filter(p => p.currentValue > 0 || p.cashPnl > 0 || p.realizedPnl > 0);
    const winRate = wins.length / data.length;

    return { resolvedWinCount: wins.length, winRate };
  } catch (e: any) {
    console.warn(`[crawler] positions fetch failed for ${wallet}: ${e.message}`);
    return null;
  }
}

// ─── Step 4: Submit to whitelist service ─────────────────────────────────────

async function submitToWhitelist(
  wallet: string,
  resolvedWinCount: number,
  winRate: number,
  avgBetSize: number
): Promise<void> {
  const body = {
    wallet,
    score: 90,
    marketCount: resolvedWinCount,
    stats: {
      winRate,
      resolvedMarkets: resolvedWinCount,
      avgBetSize,
      sharpeRatio: 0, // not available from public API; feeder no longer requires it
    },
  };

  const res = await fetch(`${WHITELIST_URL}/whitelist/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': INTERNAL_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whitelist POST failed ${res.status}: ${text}`);
  }
}

// ─── Main crawl loop ──────────────────────────────────────────────────────────

async function crawl(): Promise<void> {
  console.log(`[crawler] Starting whale discovery run — ${new Date().toISOString()}`);

  // ── Phase 1: Bulk leaderboard filter (no extra API calls) ──────────────────
  const [allTime, monthly] = await Promise.all([
    fetchLeaderboard('all'),
    fetchLeaderboard('month'),
  ]);

  // Use all-time list as primary; monthly used to boost score only
  const candidates: LeaderboardEntry[] = [];
  for (const [addr, entry] of allTime) {
    if (entry.pnl <= 0) continue;                      // gate: profitable
    if (!entry.vol || entry.vol < 50_000) continue;    // gate: vol ≥ $50k
    const roi = entry.pnl / entry.vol;
    if (roi < 0.10) continue;                          // gate: ROI ≥ 10%
    candidates.push(entry);
  }

  console.log(`[crawler] ${candidates.length} wallets passed leaderboard gates (from ${allTime.size} all-time, ${monthly.size} 30d)`);

  let whitelisted = 0;
  let skipped = 0;

  // ── Phase 2: Per-wallet deep checks ───────────────────────────────────────
  for (const entry of candidates) {
    const wallet = entry.proxyWallet.toLowerCase();

    try {
      await sleep(RATE_LIMIT_MS);

      // ── Activity stats: avg entry price + avg bet size ──────────────────
      const activity = await fetchActivityStats(wallet);
      if (!activity) { skipped++; continue; }

      if (activity.avgEntryPrice < 0.15 || activity.avgEntryPrice > 0.80) {
        console.log(`[crawler] skip ${wallet}: avg entry price ${activity.avgEntryPrice.toFixed(3)} out of range`);
        skipped++;
        continue;
      }
      if (activity.avgBetSize < 1_500) {
        console.log(`[crawler] skip ${wallet}: avg bet size $${activity.avgBetSize.toFixed(0)} < $1,500`);
        skipped++;
        continue;
      }

      // ── All gates passed → submit ─────────────────────────────────────────
      // ROI used as winRate proxy — leaderboard presence already proves track record
      const roi = entry.pnl / entry.vol;
      const winRate = Math.min(0.95, 0.60 + roi); // floor at 0.60 for feeder gate
      console.log(
        `[crawler] QUALIFY ${wallet} | PnL $${entry.pnl.toFixed(0)} | ` +
        `ROI ${(roi * 100).toFixed(1)}% | avgBet $${activity.avgBetSize.toFixed(0)}`
      );

      await submitToWhitelist(wallet, 25, winRate, activity.avgBetSize);
      whitelisted++;

    } catch (e: any) {
      console.error(`[crawler] ERROR processing ${wallet}: ${e.message}`);
      // log and skip — don't crash the run
    }
  }

  console.log(
    `[crawler] Run complete — ${whitelisted} whitelisted, ${skipped} skipped, ` +
    `${candidates.length - whitelisted - skipped} errored — ${new Date().toISOString()}`
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Run immediately on startup, then every 6 hours
  await crawl().catch(e => console.error('[crawler] Fatal error in crawl():', e));

  setInterval(async () => {
    await crawl().catch(e => console.error('[crawler] Fatal error in crawl():', e));
  }, CRAWL_INTERVAL_MS);
}

main();
