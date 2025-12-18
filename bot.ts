// =====================================================
// ALL-IN-ONE SOLANA TRADING BOT (LIVE + VERIFIED)
// Pump.fun Sniper + Copy Trading + Jupiter + Profit Share
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
   CONFIG
========================= */
const MAX_RISK_PCT = 0.03;
const MIN_SOL_BALANCE = 0.05;
const MIN_TRADE_SOL = 0.01;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE: any = "auto";
const AUTO_SELL_MINUTES = 10;
const PROFIT_SHARE_PCT = 0.1111;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const seenTx = new Set<string>();
const openPositions = new Map<string, NodeJS.Timeout>();
let pumpListenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url: string, options: any = {}) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function postLovable(row: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_API_KEY,
      },
      body: JSON.stringify(row),
    });
  } catch {}
}

async function balanceSOL(): Promise<number> {
  try {
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function tradeSize(balance: number): number {
  return Math.max(balance * MAX_RISK_PCT, MIN_TRADE_SOL);
}

/* =========================
   JUPITER SWAP (REAL)
========================= */
async function executeSwap(
  side: "BUY" | "SELL",
  mint: PublicKey,
  source: string
) {
  const bal = await balanceSOL();
  const sizeSOL = tradeSize(bal);
  if (bal < sizeSOL + 0.02) return;

  try {
    const inputMint = side === "BUY" ? SOL_MINT : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : SOL_MINT;
    const amount = Math.floor(sizeSOL * LAMPORTS_PER_SOL);

    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount,
      slippageBps: SLIPPAGE_BPS,
    });

    if (!quote || (quote as any).error) {
      throw new Error("Quote failed");
    }

    const swap = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: PRIORITY_FEE,
      },
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swap.swapTransaction, "base64")
    );
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");

    console.log(`✅ ${side} CONFIRMED https://solscan.io/tx/${sig}`);

    await postLovable({
      wallet: wallet.publicKey.toBase58(),
      side,
      mint: mint.toBase58(),
      source,
      sizeSOL,
      status: "VERIFIED",
      tx_signature: sig,
      explorer: `https://solscan.io/tx/${sig}`,
      ts: new Date().toISOString(),
    });

    return { sig, sizeSOL, quote };

  } catch (e: any) {
    console.error("❌ SWAP FAILED", e?.message || e);
    return null;
  }
}

/* =========================
   PROFIT SHARE
========================= */
async function sendProfitShare(profitSOL: number) {
  if (profitSOL <= 0) return;

  const lamports = Math.floor(profitSOL * PROFIT_SHARE_PCT * LAMPORTS_PER_SOL);

  const ix = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(CREATOR_WALLET),
    lamports,
  });

  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  await connection.sendTransaction(tx);

  console.log(`💰 Profit share sent`);
}

/* =========================
   COPY TRADING
========================= */
async function mirrorWallet(addr: string) {
  let pub: PublicKey;
  try { pub = new PublicKey(addr); } catch { return; }

  const sigs = await connection.getSignaturesForAddress(pub, { limit: 5 });

  for (const s of sigs) {
    if (seenTx.has(s.signature)) continue;
    seenTx.add(s.signature);

    const tx = await connection.getParsedTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) continue;

    const balances = tx.meta.postTokenBalances || [];
    for (const b of balances) {
      if (b.owner === addr && Number(b.uiTokenAmount.uiAmount || 0) > 0) {
        await executeSwap("BUY", new PublicKey(b.mint), "COPY");
      }
    }
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function initPumpSniper() {
  if (pumpListenerActive) return;

  connection.onLogs(PUMP_FUN_PROGRAM, async log => {
    if (log.err) return;
    if (!log.logs.some(l => l.includes("Instruction: Create"))) return;

    const tx = await connection.getParsedTransaction(log.signature, {
      maxSupportedTransactionVersion: 0,
    });

    const balances = tx?.meta?.postTokenBalances || [];
    for (const b of balances) {
      if (Number(b.uiTokenAmount.uiAmount || 0) > 0) {
        const mint = new PublicKey(b.mint);
        await executeSwap("BUY", mint, "PUMP_FUN");

        const timer = setTimeout(
          () => executeSwap("SELL", mint, "AUTO_SELL"),
          AUTO_SELL_MINUTES * 60000
        );

        openPositions.set(mint.toBase58(), timer);
        break;
      }
    }
  });

  pumpListenerActive = true;
  console.log("👂 Pump.fun sniper active");
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 ALL-IN-ONE BOT STARTED");

  initPumpSniper();

  while (true) {
    let control: any;
    try {
      control = await fetchJSON(LOVABLE_CONTROL_URL, {
        headers: { apikey: SUPABASE_API_KEY },
      });
    } catch {
      await sleep(5000);
      continue;
    }

    if (control.status !== "RUNNING") {
      await sleep(5000);
      continue;
    }

    const bal = await balanceSOL();
    if (bal < MIN_SOL_BALANCE) {
      await sleep(5000);
      continue;
    }

    try {
      const wallets: string[] = await fetchJSON(FOMO_WALLET_FEED, {
        headers: { apikey: SUPABASE_API_KEY },
      });

      for (const w of wallets.slice(0, 20)) {
        await mirrorWallet(w);
        await sleep(500);
      }
    } catch {}

    await sleep(3000);
  }
}

run();
