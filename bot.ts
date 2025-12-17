// ================================
// 🤖 HYBRID MEME BOT – FINAL VERSION
// Auto-Discovery + Wallet Leaderboard
// ================================

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// ================================
// ENV
// ================================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;

// ================================
// CONNECTION
// ================================
const connection = new Connection(RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// ================================
// GLOBAL STATE
// ================================
let TEST_MODE = true;
let KILL_SWITCH = false;

// wallet -> stats
const walletStats = new Map<string, { pnl: number; trades: number; wins: number }>();
const walletCooldown = new Map<string, number>();
const discoveredWallets = new Set<string>();

// ================================
// UTILS
// ================================
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function postLovable(row: any) {
  await fetch(LOVABLE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify(row),
  });
}

async function fetchControl() {
  const res = await fetch(LOVABLE_CONTROL_URL, {
    headers: { apikey: SUPABASE_API_KEY },
  });
  return res.json();
}

// ================================
// AUTO WALLET DISCOVERY
// ================================
async function discoverWallets() {
  // heuristic: wallets trading frequently & profitably (simulated here)
  if (Math.random() > 0.97) {
    const fakeWallet = Keypair.generate().publicKey.toBase58();
    discoveredWallets.add(fakeWallet);
    walletStats.set(fakeWallet, { pnl: 0, trades: 0, wins: 0 });
  }
}

function walletScore(w: string): number {
  const s = walletStats.get(w);
  if (!s || s.trades < 3) return 0.5;
  const winRate = s.wins / s.trades;
  if (winRate > 0.7) return 1.5;
  if (winRate < 0.4) return 0.25;
  return 1.0;
}

// ================================
// COPY TRADING ENGINE
// ================================
async function mirrorWallet(w: string, balanceSOL: number) {
  if (walletCooldown.get(w) && Date.now() < walletCooldown.get(w)!) return;

  // simulate detecting wallet trade
  if (Math.random() < 0.98) return;

  const sizeSOL = Math.max(0.003, balanceSOL * 0.02) * walletScore(w);

  if (!TEST_MODE) {
    // real swap execution here
  }

  // update stats
  const stat = walletStats.get(w)!;
  stat.trades++;
  const win = Math.random() > 0.5;
  if (win) {
    stat.wins++;
    stat.pnl += sizeSOL * 0.2;
  } else {
    stat.pnl -= sizeSOL * 0.1;
  }

  walletCooldown.set(w, Date.now() + 60_000);

  await postLovable({
    wallet: wallet.publicKey.toBase58(),
    type: 'COPY',
    source: w,
    size: sizeSOL,
    ts: new Date().toISOString(),
  });
}

// ================================
// SNIPER ENGINE (SIMPLIFIED)
// ================================
async function sniper(balanceSOL: number) {
  if (Math.random() < 0.97) return;

  const mint = 'AUTO_PUMP_MINT';
  const sizeSOL = Math.max(0.003, balanceSOL * 0.03);

  if (!TEST_MODE) {
    // real Jupiter swap here
  }

  await postLovable({
    wallet: wallet.publicKey.toBase58(),
    type: 'SNIPER',
    mint,
    size: sizeSOL,
    ts: new Date().toISOString(),
  });
}

// ================================
// LEADERBOARD EXPORT
// ================================
async function pushLeaderboard() {
  const rows = [...walletStats.entries()].map(([wallet, s]) => ({
    wallet,
    pnl: s.pnl,
    trades: s.trades,
    winRate: s.trades ? s.wins / s.trades : 0,
  }));

  for (const r of rows) {
    await postLovable({
      type: 'LEADERBOARD',
      ...r,
      ts: new Date().toISOString(),
    });
  }
}

// ================================
// MAIN LOOP
// ================================
async function run() {
  console.log('🤖 HYBRID BOT STARTED');

  while (true) {
    const control = await fetchControl();
    TEST_MODE = control.testMode;
    KILL_SWITCH = control.kill === true;

    if (KILL_SWITCH) {
      console.log('⛔ Kill switch active');
      await sleep(3000);
      continue;
    }

    const balanceSOL = 0.1;

    await discoverWallets();

    for (const w of discoveredWallets) {
      await mirrorWallet(w, balanceSOL);
    }

    await sniper(balanceSOL);
    await pushLeaderboard();

    await sleep(3000);
  }
}

run();
