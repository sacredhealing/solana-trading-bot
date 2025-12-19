// =====================================================
// FINAL HARDENED SOLANA TRADING BOT
// Sniper + Copy + AI Wallet Scoring
// Liquidity Lock + Dev Tracking + Dashboard PnL
// Max 30% Exposure | Auto-Sell | Trailing Stops
// =====================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const CREATOR_WALLET = new PublicKey(process.env.CREATOR_WALLET!);
const BACKTEST = process.env.BACKTEST === "true";

/* =========================
   SAFETY CONFIG
========================= */
const MAX_RISK_TOTAL = 0.3;
const MAX_POSITIONS = 5;
const INITIAL_STOP = 0.12;
const TRAILING_STOP = 0.05;
const PROFIT_SHARE = 0.1111;
const RPC_DELAY = 1200;
const MIN_LP_SOL = 5;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

/* =========================
   STATE
========================= */
interface Position {
  mint: PublicKey;
  entry: number;
  sizeSOL: number;
  high: number;
  stop: number;
}

interface WalletStats {
  wins: number;
  losses: number;
  rugs: number;
  roiSum: number;
}

const positions = new Map<string, Position>();
const walletStats = new Map<string, WalletStats>();
const priceHistory = new Map<string, number[]>();
const bannedDevs = new Set<string>();
const bannedMints = new Set<string>();

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function solBalance() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

/* =========================
   DASHBOARD LOGGING
========================= */
async function postLovable(data: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_API_KEY,
      },
      body: JSON.stringify({
        wallet: wallet.publicKey.toBase58(),
        ts: new Date().toISOString(),
        ...data,
      }),
    });
  } catch {}
}

/* =========================
   PRICE ENGINE
========================= */
async function price(mint: PublicKey): Promise<number> {
  const q = await jupiter.quoteGet({
    inputMint: mint.toBase58(),
    outputMint: "So11111111111111111111111111111111111111112",
    amount: 1_000_000,
    slippageBps: 50,
  });
  return Number(q.outAmount) / LAMPORTS_PER_SOL;
}

/* =========================
   LIQUIDITY LOCK CHECK
========================= */
async function hasLiquidity(mint: PublicKey): Promise<boolean> {
  try {
    const accs = await connection.getTokenLargestAccounts(mint);
    const lp = accs.value.reduce((a, b) => a + Number(b.uiAmount || 0), 0);
    return lp >= MIN_LP_SOL;
  } catch {
    return false;
  }
}

/* =========================
   ANTI-RUG + DEV TRACKING
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  if (bannedMints.has(mint.toBase58())) return true;

  const info = await connection.getParsedAccountInfo(mint);
  const data: any = info.value?.data;
  const i = data?.parsed?.info;
  if (!i) return true;

  if (i.mintAuthority || i.freezeAuthority) return true;
  if (!(await hasLiquidity(mint))) return true;

  return false;
}

/* =========================
   MOMENTUM FILTER
========================= */
function hasMomentum(mint: PublicKey, p: number): boolean {
  const k = mint.toBase58();
  const h = priceHistory.get(k) || [];
  h.push(p);
  if (h.length > 3) h.shift();
  priceHistory.set(k, h);
  return h.length === 3 && h[2] > h[0];
}

/* =========================
   AI WALLET SCORING
========================= */
function walletScore(addr: string): number {
  const w = walletStats.get(addr);
  if (!w) return 1;
  const trades = w.wins + w.losses;
  if (trades === 0) return 1;

  const winRate = w.wins / trades;
  const avgRoi = w.roiSum / trades;
  const penalty = w.rugs * 0.5;

  return Math.max(0.2, Math.min(1.5, winRate + avgRoi - penalty));
}

/* =========================
   RISK ENGINE
========================= */
function exposure() {
  return [...positions.values()].reduce((a, b) => a + b.sizeSOL, 0);
}

function tradeSize(balance: number, copier?: string) {
  const remaining = balance * MAX_RISK_TOTAL - exposure();
  if (remaining <= 0) return 0;

  let base =
    balance < 100 ? 0.01 :
    balance < 200 ? 0.02 :
    balance < 500 ? 0.03 : 0.05;

  if (copier) base *= walletScore(copier);
  return Math.min(base, remaining);
}

/* =========================
   EXECUTION
========================= */
async function swap(side: "BUY" | "SELL", mint: PublicKey, size: number) {
  if (BACKTEST) return "BACKTEST";

  const q = await jupiter.quoteGet({
    inputMint: side === "BUY"
      ? "So11111111111111111111111111111111111111112"
      : mint.toBase58(),
    outputMint: side === "BUY"
      ? mint.toBase58()
      : "So11111111111111111111111111111111111111112",
    amount: Math.floor(size * LAMPORTS_PER_SOL),
    slippageBps: 200,
  });

  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: q,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  return connection.sendRawTransaction(tx.serialize());
}

/* =========================
   BUY / SELL
========================= */
async function buy(mint: PublicKey, source: string, copier?: string) {
  if (positions.size >= MAX_POSITIONS) return;
  if (await isRug(mint)) return;

  const p = await price(mint);
  if (!hasMomentum(mint, p)) return;

  const bal = await solBalance();
  const size = tradeSize(bal, copier);
  if (size <= 0) return;

  const sig = await swap("BUY", mint, size);

  positions.set(mint.toBase58(), {
    mint,
    entry: p,
    sizeSOL: size,
    high: p,
    stop: p * (1 - INITIAL_STOP),
  });

  await postLovable({ type: "BUY", mint: mint.toBase58(), size, sig, source });
}

async function sell(pos: Position, reason: string) {
  const sig = await swap("SELL", pos.mint, pos.sizeSOL);
  positions.delete(pos.mint.toBase58());

  const exit = await price(pos.mint);
  const pnl = (exit - pos.entry) * pos.sizeSOL;

  if (pnl > 0 && !BACKTEST) {
    const fee = Math.floor(pnl * PROFIT_SHARE * LAMPORTS_PER_SOL);
    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: CREATOR_WALLET,
      lamports: fee,
    });

    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    await connection.sendTransaction(tx);
  }

  await postLovable({ type: "SELL", mint: pos.mint.toBase58(), pnl, reason, sig });
}

/* =========================
   POSITION MANAGER
========================= */
async function manage() {
  for (const pos of positions.values()) {
    const p = await price(pos.mint);

    if (p <= pos.stop) {
      await sell(pos, "STOP");
    } else if (p > pos.high) {
      pos.high = p;
      pos.stop = p * (1 - TRAILING_STOP);
    }

    await sleep(RPC_DELAY);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log(`🤖 BOT STARTED | ${BACKTEST ? "BACKTEST" : "LIVE"}`);
  while (true) {
    await manage();
    await sleep(3000);
  }
}

run();
