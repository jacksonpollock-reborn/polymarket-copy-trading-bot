import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import 'dotenv/config';

const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY!);

export const clobClient = new ClobClient(
  'https://clob.polymarket.com',
  137,
  wallet as any,
  {
    key: process.env.CLOB_API_KEY!,
    secret: process.env.CLOB_API_SECRET!,
    passphrase: process.env.CLOB_API_PASSPHRASE!,
  }
);
