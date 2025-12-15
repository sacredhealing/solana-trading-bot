// =========================
// Lovable Solana Trading Bot
// Jupiter SDK + Dynamic Quote Check + Real/Demo Mode
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
const LOVABLE_LOG_URL = process.env.LOVABLE_LOG_URL!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const BOT_INTERVAL_MS = 3000;

// =========================
// CONSTANTS
// =========================
const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const DEFAULT_SLIPPAGE_BPS = 50;

// =========================
// STATE
// =========================
let botState = {
  status: "STOPPED" as "RUNNING" | "STOPPED",
  testMode: true,
  tradeSizeSOL: 0.05,
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
  useLite: !JUPITER_API_KEY, // fallback if no key
});

console.log("✅ Wallet:", walletKeypair.publicKey.toBase58());
console.log("✅ Connected to RPC:", RPC_URL);
console.log("✅ Jupiter SDK Ready");

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
// GET QUOTE
// =========================
async function getQuote(lamports: number, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  try {
    const quotes = await jupiterApi.quoteGet({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amount: lamports,
      slippageBps,
    });

    if (!quotes || quotes.length === 0) {
      console.warn("⚠️ No valid routes found for this trade.");
      return null;
    }
    console.log(`💱 Routes found: ${quotes.length}`);
    return quotes[0];
  } catch (e) {
    console.error("Quote failed:", e);
    return null;
  }
}

// =========================
// EXECUTE SWAP
// =========================
async function executeSwap(quote: any): Promise<string | null> {
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

    if (!swapTransaction) throw new Error("No swap transaction returned");

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([walletKeypair]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

    return sig;
  } catch (e) {
    console.error("Swap failed:", e);
    return null;
  }
}

// =========================
// LOG TO LOVABLE
// =========================
async function logResult(
  txSig: string,
  inputSOL: number,
  outputUSDC: number,
  balanceSOL: number,
  status: string
) {
  if (!LOVABLE_LOG_URL) return;
  try {
    await fetch(LOVABLE_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txSig,
        inputSOL,
        outputUSDC,
        balanceSOL,
        status,
        wallet: walletKeypair.publicKey.toBase58(),
      }),
    });
  } catch (e) {
    console.error("Lovable log failed:", e);
  }
}

// =========================
// DEMO TRADE
// =========================
async function runDemoTrade() {
  const change = (Math.random() * 4 - 1.5) / 100;
  const newBal = botState.balance * (1 + change);
  console.log(`🟡 DEMO TRADE | ${(change * 100).toFixed(2)}% | Bal: ${newBal.toFixed(4)} SOL`);
  botState.balance = newBal;
}

// =========================
// BOT STEP
// =========================
async function botStep() {
  await syncDashboard();
  if (botState.status !== "RUNNING") {
    console.log("⏸️ Waiting for RUNNING state...");
    return;
  }

  const tradeSize = botState.usePercentageRisk
    ? (botState.balance * botState.tradeSizeSOL) / 100
    : botState.tradeSizeSOL;

  const lamports = Math.round(tradeSize * LAMPORTS_PER_SOL);

  if (botState.testMode) {
    console.log("🧪 DEMO MODE ACTIVE");
    await runDemoTrade();
    return;
  }

  // REAL TRADE
  console.log(`🔁 Quote for ${tradeSize.toFixed(4)} SOL`);
  const quote = await getQuote(lamports);
  if (!quote) {
    console.log("⚠️ Falling back to simulation because no valid quote found");
    await runDemoTrade();
    return;
  }

  const sig = await executeSwap(quote);
  if (!sig) {
    console.log("⚠️ Swap failed, running simulated fallback");
    await runDemoTrade();
    return;
  }

  console.log("✅ REAL SWAP executed:", sig);

  const outputUSDC = Number(quote.outAmount) / 1e6;
  const balanceSOL = await connection.getBalance(walletKeypair.publicKey) / LAMPORTS_PER_SOL;

  await logResult(sig, tradeSize, outputUSDC, balanceSOL, "success");
}

// =========================
// MAIN LOOP
// =========================
async function main() {
  console.log("🚀 Lovable Bot Launched");

  while (true) {
    try {
      await botStep();
    } catch (e) {
      console.error("Bot loop error:", e);
    }
    await new Promise((r) => setTimeout(r, BOT_INTERVAL_MS));
  }
}

main();
