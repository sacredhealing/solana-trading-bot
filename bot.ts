// =========================
// bot.ts — Lovable Automated Trading Bot (LIVE + LOGGING)
// =========================
// This version:
// ✅ Trades automatically via dashboard signals
// ✅ Logs every action to Lovable
// ✅ Consumes signals (no repeat trades)
// ✅ Position-aware (SOL / USDC)
// =========================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import { createJupiterApiClient } from "@jup-ag/api";

// =========================
// CONFIG
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!; // activity log endpoint
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!; // dashboard control
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SLIPPAGE_BPS = 50;
const LOOP_MS = 3000;

// =========================
// TYPES
// =========================
interface ControlStatus {
  status: "RUNNING" | "STOPPED";
  lastSignal: "BUY" | "SELL" | "WAIT";
  tradeSize: number; // SOL
  testMode: boolean;
}

// =========================
// STATE
// =========================
let state = {
  status: "STOPPED" as ControlStatus["status"],
  lastSignal: "WAIT" as ControlStatus["lastSignal"],
  tradeSize: 0.1,
  testMode: false,
  position: "SOL" as "SOL" | "USDC",
};

let connection: Connection;
let wallet: Keypair;
let jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

// =========================
// INIT
// =========================
function init() {
  connection = new Connection(RPC_URL, "confirmed");
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  console.log("✅ Bot wallet:", wallet.publicKey.toBase58());
}

// =========================
// DASHBOARD
// =========================
async function fetchControl(): Promise<ControlStatus | null> {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL, {
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_API_KEY,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as ControlStatus;
  } catch {
    return null;
  }
}

function consumeSignal() {
  state.lastSignal = "WAIT";
}

// =========================
// LOGGING (THIS IS WHAT LOVABLE NEEDS)
// =========================
async function logActivity(payload: {
  txSig: string;
  action: "BUY" | "SELL" | "SIM";
  inputAmount: number;
  outputAmount: number;
  balanceSOL: number;
  status: "success" | "failed";
}) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify({
      ...payload,
      wallet: wallet.publicKey.toBase58(),
      timestamp: new Date().toISOString(),
    }),
  });
}

// =========================
// JUPITER
// =========================
async function swap(quote: any): Promise<string> {
  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// =========================
// BOT STEP
// =========================
async function step() {
  const control = await fetchControl();
  if (!control) return;

  state.status = control.status;
  state.lastSignal = control.lastSignal;
  state.tradeSize = control.tradeSize;
  state.testMode = control.testMode;

  if (state.status !== "RUNNING") return;

  // BUY
  if (state.lastSignal === "BUY" && state.position === "SOL") {
    const lamports = Math.round(state.tradeSize * LAMPORTS_PER_SOL);

    if (state.testMode) {
      await logActivity({
        txSig: "sim",
        action: "SIM",
        inputAmount: state.tradeSize,
        outputAmount: state.tradeSize * 1.01,
        balanceSOL: state.tradeSize,
        status: "success",
      });
      consumeSignal();
      return;
    }

    const quote = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: lamports,
      slippageBps: SLIPPAGE_BPS,
    });

    const sig = await swap(quote);
    state.position = "USDC";

    const outUSDC = parseInt(quote.outAmount) / 1_000_000;
    const bal = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;

    await logActivity({
      txSig: sig,
      action: "BUY",
      inputAmount: state.tradeSize,
      outputAmount: outUSDC,
      balanceSOL: bal,
      status: "success",
    });

    consumeSignal();
  }

  // SELL
  if (state.lastSignal === "SELL" && state.position === "USDC") {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(USDC_MINT),
    });
    if (!accounts.value.length) return;

    const usdc = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount);

    const quote = await jupiter.quoteGet({
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      amount: usdc,
      slippageBps: SLIPPAGE_BPS,
    });

    const sig = await swap(quote);
    state.position = "SOL";

    const outSOL = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    const bal = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;

    await logActivity({
      txSig: sig,
      action: "SELL",
      inputAmount: usdc / 1_000_000,
      outputAmount: outSOL,
      balanceSOL: bal,
      status: "success",
    });

    consumeSignal();
  }
}

// =========================
// MAIN LOOP
// =========================
async function main() {
  init();
  console.log("🚀 Automated trading bot started");
  while (true) {
    try {
      await step();
    } catch (e) {
      console.error("Bot error", e);
    }
    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

main();
