// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025
// Max 30% Exposure | Trailing Stops | Volume Exit | Profit Share
// Dashboard Control | Full Test Mode PnL | Multi-Positions
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
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const CREATOR_WALLET = new PublicKey(process.env.CREATOR_WALLET!);

/* =========================
   CONFIG
========================= */
const MAX_RISK_TOTAL = 0.3; // 30% of balance
const MAX_POSITIONS = 10; // Increased for multi-position
const INITIAL_STOP = 0.12;
const TRAILING_STOP = 0.05;
const VOLUME_DROP_EXIT = 0.5; // Sell if volume < 50% of peak
const PROFIT_SHARE = 0.1111;
const MIN_LP_SOL = 5;
const RPC_DELAY = 1200;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface Position {
  mint: PublicKey;
  entryPrice: number;
  sizeSOL: number;
  highPrice: number;
  stopPrice: number;
  peakVolume: number;
  source: string;
}

interface ControlData {
  status: string;
  testMode: boolean;
  copyTrading?: { wallets?: string[] };
}

const positions = new Map<string, Position>();
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function solBalance(): Promise<number> {
  try {
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

/* =========================
   DASHBOARD CONTROL & LOGGING
========================= */
async function fetchControl(): Promise<ControlData | null> {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postLovable(data: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
      body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), ts: new Date().toISOString(), ...data }),
    });
  } catch {}
}

/* =========================
   PRICE & VOLUME (DexScreener)
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

async function getVolume24h(mint: PublicKey): Promise<number> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    const data = await r.json();
    return data.pairs?.reduce((max: number, p: any) => Math.max(max, p.volume?.h24 || 0), 0) || 0;
  } catch {
    return 0;
  }
}

/* =========================
   RUG CHECK (Top Holder + LP)
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    const data = await r.json();
    const topHolder = data.pairs?.[0]?.topHolders?.[0]?.percent || 0;
    const lp = data.pairs?.reduce((sum: number, p: any) => sum + (p.liquidity?.usd || 0), 0) / data.pairs?.[0]?.priceUsd || 0;
    return topHolder > 20 || lp < MIN_LP_SOL;
  } catch {
    return true;
  }
}

/* =========================
   RISK & SIZE
========================= */
function exposure(): number {
  return [...positions.values()].reduce((a, b) => a + b.sizeSOL, 0);
}

function tradeSize(balance: number): number {
  const remaining = balance * MAX_RISK_TOTAL - exposure();
  if (remaining <= 0) return 0;
  const base = balance < 100 ? 0.01 : balance < 200 ? 0.02 : balance < 500 ? 0.03 : 0.05;
  return Math.min(base, remaining);
}

/* =========================
   SWAP
========================= */
async function swap(side: "BUY" | "SELL", mint: PublicKey, amount: number): Promise<{ sig: string; outAmount: number } | null> {
  try {
    const inputMint = side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112";

    const quote = await jupiter.quoteGet({ inputMint, outputMint, amount: Math.floor(amount), slippageBps: 200 });
    if ((quote as any).error) throw new Error((quote as any).error);

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: { quoteResponse: quote as any, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`✅ ${side} confirmed: https://solscan.io/tx/${sig}`);

    return { sig, outAmount: Number(quote.outAmount) };
  } catch (e: any) {
    console.error(`❌ Swap ${side} failed:`, e?.message);
    return null;
  }
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  if (positions.size >= MAX_POSITIONS) return;
  if (positions.has(mint.toBase58())) return;
  if (await isRug(mint)) return;

  const bal = await solBalance();
  const sizeSOL = tradeSize(bal);
  if (sizeSOL <= 0) return;

  console.log(`🎯 ${testMode ? "TEST" : "LIVE"} BUY ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()} (${source})`);

  if (testMode) {
    const entryPrice = await getPrice(mint);
    const volume = await getVolume24h(mint);
    positions.set(mint.toBase58(), {
      mint,
      entryPrice,
      sizeSOL,
      highPrice: entryPrice,
      stopPrice: entryPrice * (1 - INITIAL_STOP),
      peakVolume: volume,
      source,
    });
    await postLovable({
      side: "BUY",
      pair: mint.toBase58(),
      sizeSOL,
      entry_price: entryPrice,
      tx_signature: "TEST_" + Date.now(),
      source,
      testMode: true,
      status: "CONFIRMED",
    });
    return;
  }

  const result = await swap("BUY", mint, sizeSOL * LAMPORTS_PER_SOL);
  if (!result) return;

  const entryPrice = await getPrice(mint);
  const volume = await getVolume24h(mint);
  positions.set(mint.toBase58(), {
    mint,
    entryPrice,
    sizeSOL,
    highPrice: entryPrice,
    stopPrice: entryPrice * (1 - INITIAL_STOP),
    peakVolume: volume,
    source,
  });

  await postLovable({
    side: "BUY",
    pair: mint.toBase58(),
    sizeSOL,
    entry_price: entryPrice,
    tx_signature: result.sig,
    source,
    testMode: false,
    status: "CONFIRMED",
  });
}

/* =========================
   SELL
========================= */
async function sell(pos: Position, reason: string, testMode: boolean) {
  const currentPrice = await getPrice(pos.mint);
  const currentVolume = await getVolume24h(pos.mint);

  const pnl = (currentPrice - pos.entryPrice) * pos.sizeSOL;
  const roi = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;

  console.log(`🔴 ${testMode ? "TEST" : "LIVE"} SELL ${pos.mint.toBase58()} | PnL: ${pnl.toFixed(4)} SOL (${roi.toFixed(2)}%) | ${reason}`);

  if (testMode) {
    positions.delete(pos.mint.toBase58());
    await postLovable({
      side: "SELL",
      pair: pos.mint.toBase58(),
      sizeSOL: pos.sizeSOL,
      entry_price: pos.entryPrice,
      exit_price: currentPrice,
      pnl,
      roi,
      reason,
      tx_signature: "TEST_" + Date.now(),
      testMode: true,
      status: "CONFIRMED",
    });
    return;
  }

  const result = await swap("SELL", pos.mint, pos.sizeSOL * LAMPORTS_PER_SOL);
  if (!result) return;

  const actualExitSOL = result.outAmount / LAMPORTS_PER_SOL;
  const actualPnl = actualExitSOL - pos.sizeSOL;
  const actualRoi = pos.sizeSOL > 0 ? (actualPnl / pos.sizeSOL) * 100 : 0;

  positions.delete(pos.mint.toBase58());

  if (actualPnl > 0) {
    const fee = Math.floor(actualPnl * PROFIT_SHARE * LAMPORTS_PER_SOL);
    try {
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
      console.log(`💰 Profit share sent: ${(actualPnl * PROFIT_SHARE).toFixed(4)} SOL`);
    } catch (e: any) {
      console.error("❌ Profit share failed:", e?.message);
    }
  }

  await postLovable({
    side: "SELL",
    pair: pos.mint.toBase58(),
    sizeSOL: pos.sizeSOL,
    entry_price: pos.entryPrice,
    exit_price: currentPrice,
    pnl: actualPnl,
    roi: actualRoi,
    reason,
    tx_signature: result.sig,
    testMode: false,
    status: "CONFIRMED",
  });
}

/* =========================
   POSITION MANAGER (Trailing + Volume Exit)
========================= */
async function manage(testMode: boolean) {
  for (const [key, pos] of positions) {
    const p = await getPrice(pos.mint);
    const v = await getVolume24h(pos.mint);

    if (p <= 0) continue;

    // Volume drop exit
    if (v < pos.peakVolume * VOLUME_DROP_EXIT) {
      await sell(pos, "VOLUME_DROP", testMode);
      continue;
    }

    // Trailing stop
    if (p <= pos.stopPrice) {
      await sell(pos, "TRAILING_STOP", testMode);
    } else if (p > pos.highPrice) {
      pos.highPrice = p;
      pos.stopPrice = p * (1 - TRAILING_STOP);
      pos.peakVolume = Math.max(pos.peakVolume, v);
      console.log(`📈 New high ${p.toFixed(8)} | Stop ${pos.stopPrice.toFixed(8)} | Volume ${v.toFixed(0)}`);
    }

    await sleep(RPC_DELAY);
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
      if (!log.logs.some(l => l.includes("Create"))) return;

      try {
        const tx = await connection.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta?.postTokenBalances) return;
        for (const b of tx.meta.postTokenBalances) {
          if (Number(b.uiTokenAmount.uiAmountString || 0) > 0) {
            const mint = new PublicKey(b.mint);
            console.log(`🆕 New pump.fun token: ${mint.toBase58()}`);
            await buy(mint, "PUMP_FUN", testMode);
            break;
          }
        }
      } catch (e: any) {
        console.error("Sniper error:", e?.message);
      }
    },
    "confirmed"
  );

  listenerActive = true;
  console.log("🎯 Pump.fun sniper ACTIVE");
}

/* =========================
   COPY TRADING
========================= */
async function mirrorWallets(wallets: string[], testMode: boolean) {
  for (const addr of wallets) {
    try {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(addr), { limit: 5 });
      for (const sigInfo of sigs) {
        const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta?.postTokenBalances) continue;
        for (const b of tx.meta.postTokenBalances) {
          if (b.owner === addr && Number(b.uiTokenAmount.uiAmountString || 0) > 0) {
            await buy(new PublicKey(b.mint), `COPY_${addr.slice(0,8)}`, testMode);
          }
        }
      }
    } catch {}
    await sleep(RPC_DELAY);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 ULTIMATE MEME SNIPER BOT STARTED");

  while (true) {
    const control = await fetchControl();
    const bal = await solBalance();

    if (!control || control.status !== "RUNNING") {
      console.log(`⏸ Paused | Balance: ${bal.toFixed(4)} SOL`);
      await sleep(10000);
      continue;
    }

    const testMode = control.testMode === true;
    console.log(`🔄 ${testMode ? "TEST" : "LIVE"} | Balance: ${bal.toFixed(4)} SOL | Positions: ${positions.size}`);

    initPumpSniper(testMode);

    const copyWallets = control.copyTrading?.wallets || [];
    if (copyWallets.length > 0) {
      await mirrorWallets(copyWallets, testMode);
    }

    await manage(testMode);

    await sleep(3000);
  }
}

run();
