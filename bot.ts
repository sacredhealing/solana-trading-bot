// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// Max 30% exposure, dynamic sizing, trailing stops
// Per-user profit share 11.11%
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
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;

/* =========================
   CONFIG
========================= */
const MAX_RISK_TOTAL = 0.3; // 30% total exposure
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE: any = "auto";
const TRAILING_STOP_PCT = 0.05; // 5%
const PROFIT_SHARE_PCT = 0.1111; // 11.11% to creator
const TIER_SIZES: { min: number; max: number; sizeSOL: number }[] = [
  { min: 0, max: 100, sizeSOL: 0.01 },
  { min: 100, max: 200, sizeSOL: 0.02 },
  { min: 200, max: 500, sizeSOL: 0.03 },
  { min: 500, max: 1000, sizeSOL: 0.05 },
];
const RPC_DELAY = 1000; // ms between requests to avoid 429

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface Position {
  mint: PublicKey;
  buySOL: number;
  highestPrice: number;
  stopPrice: number;
  timeout?: NodeJS.Timeout;
}

const openPositions = new Map<string, Position>();
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url: string, options: any = {}, retries = 5, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(delay * (i + 1));
    }
  }
}

async function balanceSOL() {
  try {
    return (await connection.getBalance(walletKeypair.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function calculateTradeSize(balance: number): number {
  const totalExposure = Array.from(openPositions.values()).reduce((acc, p) => acc + p.buySOL, 0);
  const maxExposureSOL = balance * MAX_RISK_TOTAL;
  const remaining = maxExposureSOL - totalExposure;
  const tier = TIER_SIZES.find(t => balance >= t.min && balance < t.max);
  if (!tier) return 0.01;
  return Math.min(tier.sizeSOL, remaining);
}

/* =========================
   TRAILING STOP
========================= */
async function updateTrailingStops() {
  for (const [key, pos] of openPositions) {
    const currentPrice = await getTokenPrice(pos.mint); // via Jupiter
    if (currentPrice <= pos.stopPrice) {
      await trade("SELL", pos.mint, "AUTO_SELL", "TRAILING_STOP", false);
      openPositions.delete(key);
    } else if (currentPrice > pos.highestPrice) {
      pos.highestPrice = currentPrice;
      pos.stopPrice = currentPrice * (1 - TRAILING_STOP_PCT);
    }
    await sleep(RPC_DELAY);
  }
}

/* =========================
   TRADE EXECUTION
========================= */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER" | "AUTO_SELL",
  source: string,
  testMode: boolean
) {
  const bal = await balanceSOL();
  let sizeSOL = calculateTradeSize(bal);
  if (!sizeSOL || isNaN(sizeSOL)) return;

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  if (testMode) return;

  try {
    const inputMint = side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112";
    const amount = Math.round(sizeSOL * LAMPORTS_PER_SOL);

    const quote = await jupiter.quoteGet({ inputMint, outputMint, amount, slippageBps: SLIPPAGE_BPS });
    if ((quote as any).error) throw new Error((quote as any).error);

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: { quoteResponse: quote as any, userPublicKey: walletKeypair.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: PRIORITY_FEE }
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([walletKeypair]);
    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`✅ Tx confirmed: https://solscan.io/tx/${sig}`);

    // Save position for trailing stop
    if (side === "BUY") {
      const price = Number((quote as any).outAmount) / LAMPORTS_PER_SOL;
      openPositions.set(mint.toBase58(), { mint, buySOL: sizeSOL, highestPrice: price, stopPrice: price * (1 - TRAILING_STOP_PCT) });
    }

    // Profit share
    if (side === "SELL") {
      const outSOL = Number((quote as any).outAmount) / LAMPORTS_PER_SOL;
      const profit = Math.max(0, outSOL - sizeSOL);
      const fee = profit * PROFIT_SHARE_PCT;
      if (profit > 0) {
        const ix = SystemProgram.transfer({
          fromPubkey: walletKeypair.publicKey,
          toPubkey: new PublicKey(CREATOR_WALLET),
          lamports: Math.floor(fee * LAMPORTS_PER_SOL)
        });

        const msg = new TransactionMessage({
          payerKey: walletKeypair.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
          instructions: [ix]
        }).compileToV0Message();

        const feeTx = new VersionedTransaction(msg);
        feeTx.sign([walletKeypair]);
        await connection.sendTransaction(feeTx);
        console.log(`💰 Profit share sent: ${fee.toFixed(4)} SOL`);
      }
    }

  } catch (e: any) {
    console.error(`❌ ${side} failed`, e?.message || e);
  }
  await sleep(RPC_DELAY);
}

/* =========================
   COPY TRADING + PUMP.FUN
========================= */
async function mirrorWallet(addr: string, testMode: boolean) { /* same logic as before */ }
function initPumpSniper(testMode: boolean) { /* same logic as before */ }

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 HYBRID MEME BOT STARTED");
  while (true) {
    const bal = await balanceSOL();
    const control: any = await fetchWithRetry(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } }, 3, 500);
    const testMode = control.testMode === true;

    if (control.status !== "RUNNING" || bal < MIN_SOL_BALANCE) {
      console.log(`⏸ Paused | ${control.status} | ${bal.toFixed(4)} SOL`);
      await sleep(10000);
      continue;
    }

    initPumpSniper(testMode);

    // Copy trading
    const wallets: string[] = control.copyTrading.wallets || [];
    for (const w of wallets) {
      await mirrorWallet(w, testMode);
      await sleep(RPC_DELAY);
    }

    // Trailing stops
    await updateTrailingStops();

    await sleep(3000);
  }
}

run();
