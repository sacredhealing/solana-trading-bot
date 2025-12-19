// =====================================================
// FINAL SAFE SOLANA MEME SNIPER BOT
// Capital Protection First | Test-Mode Ready
// =====================================================

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
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
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const CREATOR_WALLET = new PublicKey(process.env.CREATOR_WALLET!);

/* =========================
   CONFIG
========================= */
const MAX_TOTAL_EXPOSURE = 0.3;
const MAX_POSITIONS = 5;
const INITIAL_STOP = 0.12;
const TRAILING_STOP = 0.05;
const PROFIT_SHARE = 0.1111;
const MIN_LP_SOL = 5;
const TOKEN_COOLDOWN_MS = 30 * 60 * 1000;
const RPC_DELAY = 1200;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/* =========================
   TYPES
========================= */
interface Position {
  mint: PublicKey;
  entryPrice: number;
  sizeSOL: number;
  high: number;
  stop: number;
  source: string;
}

interface ControlData {
  status: string;
  testMode: boolean;
  copyTrading?: { wallets?: string[] };
}

/* =========================
   STATE
========================= */
const positions = new Map<string, Position>();
const cooldowns = new Map<string, number>();
let sniperActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function solBalance(): Promise<number> {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

function totalExposure(): number {
  return [...positions.values()].reduce((a, p) => a + p.sizeSOL, 0);
}

function canBuy(balance: number): boolean {
  return (
    positions.size < MAX_POSITIONS &&
    totalExposure() < balance * MAX_TOTAL_EXPOSURE
  );
}

function tradeSize(balance: number): number {
  const remaining = balance * MAX_TOTAL_EXPOSURE - totalExposure();
  if (remaining <= 0) return 0;

  if (balance < 100) return Math.min(0.01, remaining);
  if (balance < 200) return Math.min(0.02, remaining);
  if (balance < 500) return Math.min(0.03, remaining);
  return Math.min(0.05, remaining);
}

/* =========================
   DASHBOARD
========================= */
async function fetchControl(): Promise<ControlData | null> {
  try {
    const r = await fetch(LOVABLE_CONTROL_URL, {
      headers: { apikey: SUPABASE_API_KEY },
    });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

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
   PRICE
========================= */
async function getPrice(mint: PublicKey): Promise<number> {
  try {
    const q = await jupiter.quoteGet({
      inputMint: mint.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: 1_000_000,
      slippageBps: 50,
    });
    return Number(q.outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

/* =========================
   ANTI-RUG
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const info = await connection.getParsedAccountInfo(mint);
    const i = (info.value?.data as any)?.parsed?.info;
    if (i?.mintAuthority || i?.freezeAuthority) return true;

    const largest = await connection.getTokenLargestAccounts(mint);
    const lp = largest.value.reduce(
      (a, b) => a + Number(b.uiAmount || 0),
      0
    );
    return lp < MIN_LP_SOL;
  } catch {
    return true;
  }
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  const key = mint.toBase58();
  const now = Date.now();

  if (cooldowns.get(key) && now - cooldowns.get(key)! < TOKEN_COOLDOWN_MS)
    return;

  const balance = await solBalance();
  if (!canBuy(balance)) return;
  if (await isRug(mint)) return;

  const sizeSOL = tradeSize(balance);
  if (sizeSOL <= 0) return;

  const entry = await getPrice(mint);
  if (entry <= 0) return;

  console.log(`🟢 ${testMode ? "TEST" : "LIVE"} BUY ${key}`);

  positions.set(key, {
    mint,
    entryPrice: entry,
    sizeSOL,
    high: entry,
    stop: entry * (1 - INITIAL_STOP),
    source,
  });

  cooldowns.set(key, now);

  await postLovable({
    side: "BUY",
    mint: key,
    sizeSOL,
    entry,
    source,
    testMode,
  });
}

/* =========================
   SELL
========================= */
async function sell(pos: Position, reason: string, testMode: boolean) {
  const price = await getPrice(pos.mint);
  const pnl = pos.sizeSOL * (price / pos.entryPrice - 1);

  positions.delete(pos.mint.toBase58());

  await postLovable({
    side: "SELL",
    mint: pos.mint.toBase58(),
    pnl,
    reason,
    testMode,
  });

  if (!testMode && pnl > 0) {
    const fee = pnl * PROFIT_SHARE;
    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: CREATOR_WALLET,
      lamports: Math.floor(fee * LAMPORTS_PER_SOL),
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
}

/* =========================
   POSITION MANAGER
========================= */
async function manage(testMode: boolean) {
  for (const pos of positions.values()) {
    const p = await getPrice(pos.mint);
    if (p <= 0) continue;

    if (p <= pos.stop) {
      await sell(pos, "STOP", testMode);
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
  console.log("🤖 SAFE BOT STARTED");

  while (true) {
    const control = await fetchControl();
    if (!control || control.status !== "RUNNING") {
      await sleep(10000);
      continue;
    }

    await manage(control.testMode);
    await sleep(3000);
  }
}

run();
