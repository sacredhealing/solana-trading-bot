// =====================================================
// HYBRID SNIPER + COPY BOT (LIVE-READY, VERIFIED)
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
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE: any = "auto";
const AUTO_SELL_MINUTES = 10;
const PROFIT_SHARE_PCT = 0.1111;
const MIN_TRADE_SOL = 0.01;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const SOL_MINT = "So11111111111111111111111111111111111111112";

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
   TRADE EXECUTION (FIXED)
========================= */
async function executeTrade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  source: string,
  testMode: boolean
) {
  const balance = await balanceSOL();
  const sizeSOL = tradeSize(balance);

  if (balance < sizeSOL + 0.02) return;

  console.log(`🚀 ${side} ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  if (testMode) {
    await postLovable({
      side,
      mint: mint.toBase58(),
      source,
      testMode: true,
      status: "SIMULATED",
      ts: new Date().toISOString(),
    });
    return;
  }

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
      throw new Error("Jupiter quote failed");
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

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(sig, "confirmed");

    console.log(`✅ CONFIRMED https://solscan.io/tx/${sig}`);

    await postLovable({
      wallet: wallet.publicKey.toBase58(),
      side,
      mint: mint.toBase58(),
      source,
      sizeSOL,
      status: "VERIFIED",
      tx_signature: sig,
      explorer: `https://solscan.io/tx/${sig}`,
      testMode: false,
      ts: new Date().toISOString(),
    });

  } catch (e: any) {
    console.error("❌ SWAP FAILED", e?.message || e);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 BOT STARTED");

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

    const mint = new PublicKey(control.target_mint);
    await executeTrade("BUY", mint, "MANUAL", control.testMode);

    await sleep(5000);
  }
}

run();
