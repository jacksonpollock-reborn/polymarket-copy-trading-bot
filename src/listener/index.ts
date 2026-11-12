import { ethers } from 'ethers';
import { redis } from '../lib/redis';
import { getWhitelist } from '../lib/db';
import 'dotenv/config';

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const ORDER_FILLED_TOPIC = ethers.id('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');

const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
];

const iface = new ethers.Interface(CTF_EXCHANGE_ABI);

// Poll every 30 seconds — prediction markets don't need 2s latency, and this fits within Alchemy free tier
const POLL_INTERVAL_MS = 30_000;

async function processLog(log: ethers.Log, whitelist: Set<string>, provider: ethers.JsonRpcProvider) {
  try {
    const decoded = iface.parseLog(log);
    if (!decoded) return;

    const maker = decoded.args.maker.toLowerCase();
    if (!whitelist.has(maker)) return;

    const tokenId = decoded.args.makerAssetId.toString();
    const side = decoded.args.makerAssetId > decoded.args.takerAssetId ? 'BUY' : 'SELL';
    const usdcAmount = ethers.formatUnits(decoded.args.takerAmountFilled, 6);
    const shares = ethers.formatUnits(decoded.args.makerAmountFilled, 6);

    // Snapshot whale's TOTAL balance (not just this tx)
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
      whaleSharesTotal,
      txHash: log.transactionHash,
      detectedAt: Date.now(),
    };

    await redis.publish('raw_trade', JSON.stringify(payload));
    console.log(`[DETECTED] ${side} by ${maker.slice(0, 8)}... $${usdcAmount} USDC`);

  } catch (e: any) {
    console.error('Parse error:', e.message);
  }
}

async function startListener() {
  // Use HTTPS provider — no persistent WebSocket connection, cheaper CU usage
  const rpcUrl = process.env.POLYGON_WSS_RPC!.replace('wss://', 'https://').replace('ws://', 'http://');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  let whitelist = await getWhitelist();
  console.log(`Listener started. Watching ${whitelist.size} whitelisted wallets.`);

  // Reload whitelist every hour
  setInterval(async () => {
    whitelist = await getWhitelist();
    console.log(`[whitelist] Reloaded — watching ${whitelist.size} wallets`);
  }, 60 * 60 * 1000);

  let lastBlock = await provider.getBlockNumber();
  console.log(`[listener] Starting from block ${lastBlock}. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastBlock) return;

      const logs = await provider.getLogs({
        address: CTF_EXCHANGE,
        topics: [ORDER_FILLED_TOPIC],
        fromBlock: lastBlock + 1,
        toBlock: currentBlock,
      });

      lastBlock = currentBlock;

      if (logs.length > 0) {
        console.log(`[listener] Blocks up to ${currentBlock}: ${logs.length} CTF event(s)`);
      }

      for (const log of logs) {
        await processLog(log, whitelist, provider);
      }
    } catch (e: any) {
      console.error('[listener] Poll error:', e.message);
    }
  }, POLL_INTERVAL_MS);
}

startListener();
