// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// Trailing stops, dynamic sizing, profit share integrated
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
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;

/* =========================
   USER RISK CONFIG
========================= */
const MAX_RISK_PCT = 0.03;
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE: any = "auto";
const PROFIT_SHARE_PCT = 0.1111;
const SIMULATED_TRADE_SIZE = 0.01;
const TRAILING_STOP_PCT = 0.05; // Sell if price drops 5% from peak

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const seenTx = new Set<string>();
const openPositions = new Map<
  string,
  { timeout?: NodeJS.Timeout; peakPrice: number; sizeSOL: number; mint: PublicKey; type: string; source: string }
>();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function fetchControl(): Promise<any> {
  try {
    return await fetchWithRetry(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } }, 3, 500);
  } catch {
    return { status: "STOPPED", testMode: true };
  }
}

async function postLovable(row: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
      body: JSON.stringify(row),
    });
  } catch {}
}

async function balanceSOL() {
  try {
    return (await connection.getBalance(walletKeypair.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function tradeSize(balance: number) {
  return Math.max(balance * MAX_RISK_PCT, 0.01);
}

/* =========================
   FOMO WALLETS
========================= */
async function fetchTopFomoWallets(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFomoRefresh < 3600000 && cachedFomoWallets.length)
    return cachedFomoWallets;

  try {
    const data: any = await fetchWithRetry(FOMO_WALLET_FEED, { headers: { apikey: SUPABASE_API_KEY } }, 5, 1000);
    const rows = Array.isArray(data) ? data : data.data || [];
    cachedFomoWallets = rows
      .map((r: any) => r.wallet || r.address || r.pubkey || r.Wallet)
      .filter((w?: string) => w && w.length > 30 && w.length < 50)
      .slice(0, 30);

    console.log(`🔥 Loaded ${cachedFomoWallets.length} FOMO wallets`);
  } catch (e) {
    console.error("FOMO load failed:", e);
    cachedFomoWallets = [];
  }

  lastFomoRefresh = now;
  return cachedFomoWallets;
}

/* =========================
   RUG CHECK (placeholder)
========================= */
async function isRug(_mint: PublicKey): Promise<boolean> {
  return false;
}

/* =========================
   COPY TRADING
========================= */
async function mirrorWallet(addr: string, testMode: boolean) {
  let pub: PublicKey;
  try {
    pub = new PublicKey(addr);
  } catch {
    return;
  }

  let sigs: any[] = [];
  try {
    sigs = await connection.getSignaturesForAddress(pub, { limit: 5 });
  } catch (e) {
    console.error("RPC error:", e);
    return;
  }

  for (const s of sigs) {
    if (seenTx.has(s.signature)) continue;
    seenTx.add(s.signature);

    let tx: any;
    try {
      tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
      console.error("RPC error:", e);
      continue;
    }
    if (!tx?.meta) continue;

    const transfers = tx.meta.postTokenBalances?.filter((b: any) => b.owner === addr) || [];
    for (const bal of transfers) {
      const mint = new PublicKey(bal.mint);
      if (await isRug(mint)) continue;

      const pre = tx.meta.preTokenBalances?.find((p: any) => p.mint === bal.mint && p.owner === addr);
      const bought = Number(bal.uiTokenAmount.uiAmountString || 0) - (pre ? Number(pre.uiTokenAmount.uiAmountString || 0) : 0);
      if (bought > 0.01) {
        await trade("BUY", mint, "COPY", addr, testMode);
      }
    }
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function initPumpSniper(testMode: boolean) {
  if (listenerActive) return;

  connection.onLogs(
    PUMP_FUN_PROGRAM,
    async (log) => {
      if (log.err) return;
      console.log(`Pump.fun log detected (sig: ${log.signature})`);

      const tx = await connection.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta?.postTokenBalances) return;

      for (const bal of tx.meta.postTokenBalances) {
        if (Number(bal.uiTokenAmount.uiAmountString || 0) > 0) {
          const mint = new PublicKey(bal.mint);
          console.log(`🆕 SNIPING new token: ${mint.toBase58()}`);
          const balSOL = await balanceSOL();
          const sizeSOL = tradeSize(balSOL);
          openPositions.set(mint.toBase58(), { peakPrice: 0, sizeSOL, mint, type: "SNIPER", source: "pump.fun" });
          await trade("BUY", mint, "SNIPER", "pump.fun", testMode);
          trackTrailingStop(mint);
          return; // Only one per tx
        }
      }
    },
    "confirmed"
  );

  listenerActive = true;
  console.log("👂 Pump.fun sniper ACTIVE");
}

/* =========================
   TRAILING STOP
========================= */
async function getTokenPrice(mint: PublicKey) {
  try {
    const quote = await jupiter.quoteGet({
      inputMint: mint.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: 1_000_000, // dummy amount
      slippageBps: SLIPPAGE_BPS,
    });
    return Number((quote as any).outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function trackTrailingStop(mint: PublicKey) {
  const pos = openPositions.get(mint.toBase58());
  if (!pos) return;

  const interval = setInterval(async () => {
    const price = await getTokenPrice(mint);
    if (price > pos.peakPrice) pos.peakPrice = price;

    if (pos.peakPrice > 0 && price / pos.peakPrice < 1 - TRAILING_STOP_PCT) {
      clearInterval(interval);
      console.log(`📉 TRAILING STOP triggered for ${mint.toBase58()}`);
      await trade("SELL", mint, pos.type, pos.source, false);
      openPositions.delete(mint.toBase58());
    }
  }, 5000);
}

/* =========================
   TRADE EXECUTION
========================= */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const bal = await balanceSOL();
  let sizeSOL = tradeSize(bal);
  if (!sizeSOL || isNaN(sizeSOL)) sizeSOL = SIMULATED_TRADE_SIZE;

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  let profitSOL = 0;
  let profitPercent = 0;

  if (testMode) {
    profitPercent = Math.random() * 13 - 3;
    profitSOL = sizeSOL * (profitPercent / 100);
  }

  await postLovable({
    wallet: walletKeypair.publicKey.toBase58(),
    type, source, mint: mint.toBase58(),
    side, size: sizeSOL, testMode,
    status: testMode ? "simulated" : "pending",
    profitSOL, profitPercent,
    ts: new Date().toISOString(),
  });

  if (testMode) return;
  if (bal < sizeSOL + 0.02) return;

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
    console.log(`✅ Tx sent: https://solscan.io/tx/${sig}`);

    // Profit share to creator on SELL
    if (side === "SELL") {
      const outSOL = Number((quote as any).outAmount) / LAMPORTS_PER_SOL;
      if (outSOL > sizeSOL) {
        const profit = outSOL - sizeSOL;
        const fee = profit * PROFIT_SHARE_PCT;
        const ix = SystemProgram.transfer({
          fromPubkey: walletKeypair.publicKey,
          toPubkey: new PublicKey(CREATOR_WALLET),
          lamports: Math.floor(fee * LAMPORTS_PER_SOL),
        });

        const msg = new TransactionMessage({
          payerKey: walletKeypair.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const feeTx = new VersionedTransaction(msg);
        feeTx.sign([walletKeypair]);
        await connection.sendTransaction(feeTx);

        console.log(`💰 11.11% fee sent (${fee.toFixed(4)} SOL)`);
      }
    }

  } catch (e: any) {
    console.error(`❌ ${side} failed`, e?.message || e);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 HYBRID MEME BOT STARTED");

  while (true) {
    const control: any = await fetchControl();
    const testMode = control.testMode === true;
    const bal = await balanceSOL();

    if (control.status !== "RUNNING" || bal < MIN_SOL_BALANCE) {
      console.log(`⏸ Paused | ${control.status} | ${bal.toFixed(4)} SOL`);
      await sleep(10000);
      continue;
    }

    initPumpSniper(testMode);

    const wallets = control.copyTrading?.wallets || await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w, testMode);
      await sleep(500);
    }

    await sleep(3000);
  }
}

run();
