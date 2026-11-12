import { Pool } from 'pg';
import 'dotenv/config';

export const db = new Pool({ connectionString: process.env.DATABASE_URL });

export async function getWhitelist(): Promise<Set<string>> {
  const res = await db.query('SELECT address FROM whitelist');
  return new Set(res.rows.map(r => r.address.toLowerCase()));
}
