// =========================
// Lovable Solana Trading Bot
// Railway Version with Dashboard Control
// Jupiter SDK Integrated
// =========================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

// =========================
// CONFIGURATION
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL || "";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const LOVABLE_API_URL = process.env.LOVABLE_API_URL || "";
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL || "";

// Jupiter API (official)
const jupiterApi = createJupiterApiClient({
  apiKey: process.env.JUPITER_API_KEY || "59a678ac-3850-4a79-9161-ff38f92fc2e4",
});

const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;

// =========================
// BOT STATE
// =========================
let botState = {
  balance: 0,
  initialBalance: 0,
  status: "STOPPED" as "RUNNING" | "STOPPED",
  last_signal: "WAIT" as "BUY" | "WAIT" | "EXIT",
  regime: "HOT" as "HOT" | "WARM" | "COLD",
  tradeSizeSOL: 0.1,
  usePercentageRisk: false,
};

// =========================
// INITIALIZATION
// =========================
let connection: Connection;
let walletKeypair: Keypair;

function initialize(): boolean {
  try {
    connection = new Connection(RPC_URL, "confirmed");
    walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

    console.log("✅ Wallet:", walletKeypair.publicKey.toBase58());
    console.log("✅ Jupiter SDK Ready");

    return true;
  } catch (e) {
    console.error("Init error:", e);
    return false;
  }
}

// =========================
// DASHBOARD CONTROL
// =========================
async function syncWithDashboard() {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL);
    if (!res.ok) return;
    const c = await res.json();

    botState.status = c.status;
    botState.tradeSizeSOL = c.trade_size_sol;
    botState.usePercentageRisk = c.use_percentage_risk;
    botState.balance = c.balance;
    botState.initialBalance = c.initial_balance;
  } catch {}
}

// =========================
// JUPITER (OFFICIAL SDK)
// =========================
async function getQuote(amountLamports: number) {
  return await jupiterApi.quoteGet({
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: amountLamports,
    slippageBps: SLIPPAGE_BPS,
  });
}

async function executeSwap(quote: any) {
  try {
    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
    );

    tx.sign([walletKeypair]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig);

    return sig;
  } catch (e) {
    console.error("Swap failed:", e);
    return null;
  }
}

// =========================
// BOT STEP
// =========================
async function botStep() {
  await syncWithDashboard();
  if (botState.status !== "RUNNING") return;

  const regimes = ["HOT", "WARM", "COLD"] as const;
  const signals = ["BUY", "WAIT", "EXIT"] as const;

  botState.regime = regimes[Math.floor(Math.random() * 3)];
  botState.last_signal = signals[Math.floor(Math.random() * 3)];

  if (botState.last_signal !== "BUY" || botState.regime === "COLD") {
    console.log("⏸️ Waiting...");
    return;
  }

  const tradeSize = botState.usePercentageRisk
    ? (botState.balance * botState.tradeSizeSOL) / 100
    : botState.tradeSizeSOL;

  const lamports = Math.round(tradeSize * LAMPORTS_PER_SOL);

  const quote = await getQuote(lamports);
  const sig = await executeSwap(quote);

  if (sig) console.log("✅ Swap TX:", sig);
}

// =========================
// MAIN LOOP
// =========================
async function main() {
  console.log("🚀 Lovable Bot — Jupiter SDK");
  if (!initialize()) process.exit(1);

  while (true) {
    await botStep();
    await new Promise(r => setTimeout(r, BOT_INTERVAL_MS));
  }
}

main();
