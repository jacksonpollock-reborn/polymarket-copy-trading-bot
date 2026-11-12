const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export const gammaClient = {
  async getMarket(tokenId: string) {
    const res = await fetch(`${GAMMA_BASE}/markets?clob_token_ids=${tokenId}`);
    const data = await res.json();
    const m = data[0];
    if (!m) return null;
    // Parse JSON-encoded arrays returned by gamma API
    const clobTokenIds: string[] = JSON.parse(m.clobTokenIds || '[]');
    const outcomePrices: string[] = JSON.parse(m.outcomePrices || '[]');
    const outcomes: string[] = JSON.parse(m.outcomes || '[]');
    const tokenIndex = clobTokenIds.indexOf(tokenId);
    const midPrice = tokenIndex >= 0 ? parseFloat(outcomePrices[tokenIndex] || '0') : 0;
    return { ...m, clobTokenIds, outcomePrices, outcomes, midPrice };
  }
};
