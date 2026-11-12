import express from 'express';
import { evaluateWalletForWhitelist } from './feeder';
import 'dotenv/config';

const app = express();
app.use(express.json());

app.post('/whitelist/evaluate', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { wallet, score, marketCount, stats } = req.body;
  await evaluateWalletForWhitelist(wallet, score, marketCount, stats);
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Whitelist server on port 3000'));
