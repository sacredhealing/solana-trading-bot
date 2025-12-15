// =========================
// Lovable Solana Trading Bot
// Railway Version with Dashboard Control
// Jupiter SDK + Real/Demo Modes
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
// ENV CONFIG
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const JUPITER_API_KEY =
  process.env.JUPITER_API_KEY || "59a678ac-3850-4a79-9161-ff38f92fc2e4";

// =========================
// CONSTANTS
// =========================
const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;

// =========================
// STATE
// =========================
let botState = {
  status: "STOPPED" as "RUNNING" | "STOPPED",
  testMode: true,
  tradeSizeSOL: 0.1,
  usePercentageRisk: false,
  balance: 0,
  initialBalance: 0,
};

// =========================
// SETUP
// =========================
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

const jupiterApi = createJupiterApiClient({
  apiKey: JUPITER_API_KEY,
});

console.log("✅ Wallet:", walletKeypair.publicKey.toBase58());
console.log("✅ Jupiter SDK ready");

// =========================
// DASHBOARD SYNC
// =========================
async function syncDashboard() {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL);
    if (!res.ok) return;

    const c = await res.json();
    botState.status = c.status;
    botState.testMode = c.test_mode;
    botState.tradeSizeSOL = c.trade_size_sol;
    botState.usePercentageRisk = c.use_percentage_risk;
    botState.balance = c.balance;
    botState.initialBalance = c.initial_balance;
  } catch (e) {
    console.error("Dashboard sync failed:", e);
  }
}

// =========================
// JUPITER
// =========================
async function getQuote(lamports: number) {
  return jupiterApi.quoteGet({
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: lamports,
    slippageBps: SLIPPAGE_BPS,
  });
}

async function executeRealSwap(quote: any): Promise<string | null> {
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
    console.error("❌ REAL swap failed:", e);
    return null;
  }
}

// =========================
// DEMO TRADE (SAFE)
// =========================
function runDemoTrade() {
  const change = (Math.random() * 4 - 1.5) / 100;
  const newBal = botState.balance * (1 + change);

  console.log(
    `🟡 DEMO TRADE | ${(change * 100).toFixed(2)}% | Bal: ${newBal.toFixed(
      4
    )} SOL`
  );

  botState.balance = newBal;
}

// =========================
// BOT STEP
// =========================
async function botStep() {
  await syncDashboard();

  if (botState.status !== "RUNNING") {
    console.log("⏸️ Waiting for RUNNING signal...");
    return;
  }

  const tradeSize = botState.usePercentageRisk
    ? (botState.balance * botState.tradeSizeSOL) / 100
    : botState.tradeSizeSOL;

  const lamports = Math.round(tradeSize * LAMPORTS_PER_SOL);

  // =========================
  // DEMO MODE
  // =========================
  if (botState.testMode) {
    console.log("🧪 DEMO MODE ACTIVE");
    runDemoTrade();
    return;
  }

  // =========================
  // REAL MODE
  // =========================
  console.log(`🟢 REAL TRADE | ${tradeSize.toFixed(4)} SOL`);

  const quote = await getQuote(lamports);
  if (!quote) {
    console.error("❌ Quote failed");
    return;
  }

  const sig = await executeRealSwap(quote);
  if (sig) {
    console.log("✅ REAL TX:", sig);
  }
}

// =========================
// MAIN LOOP
// =========================
async function main() {
  console.log("🚀 Lovable Bot (REAL + DEMO SAFE MODE)");

  while (true) {
    try {
      await botStep();
    } catch (e) {
      console.error("Bot error:", e);
    }
    await new Promise(r => setTimeout(r, BOT_INTERVAL_MS));
  }
}

main();
