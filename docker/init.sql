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
