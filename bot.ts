// =========================
// Lovable Solana Trading Bot
// Jupiter SDK + Priority Fee & Reliable Swap
// =========================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  createJupiterApiClient,
  getPriorityFees,
} from "@jup-ag/api"; // SDK package

// =========================
// ENV CONFIG
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_LOG_URL = process.env.LOVABLE_LOG_URL!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const PRIORITY_FEE_MULTIPLIER = parseInt(process.env.PRIORITY_FEE_MULTIPLIER || "1");

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
// SETUP CONNECTION + WALLET
// =========================
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiterApi = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

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
// JUPITER QUOTE
// =========================
async function getJupiterQuote(lamports: number): Promise<any | null> {
  try {
    const quotes = await jupiterApi.quoteGet({
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amount: lamports,
      slippageBps: SLIPPAGE_BPS,
    });
    if (!quotes || quotes.length === 0) {
      console.warn("⚠️ No valid routes found");
      return null;
    }
    console.log(`💱 Routes found: ${quotes.length}`);
    return quotes[0]; // best route
  } catch (e) {
    console.error("Quote error:", e);
    return null;
  }
}

// =========================
// EXECUTE SWAP
// =========================
async function executeSwap(quote: any): Promise<string | null> {
  try {
    // optional: calculate priority fees
    const priorityFees = await getPriorityFees(connection);
    const prioritization = Math.round(priorityFees * PRIORITY_FEE_MULTIPLIER);

    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        // optionally adding prioritized fee
        prioritizationFeeLamports: prioritization.toString(),
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
    console.error("❌ Swap failed:", e);
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
    console.log("🧪 DEMO MODE");
    return;
  }

  console.log(`🔁 Quote for ${tradeSize.toFixed(4)} SOL`);
  const quote = await getJupiterQuote(lamports);
  if (!quote) return;

  const sig = await executeSwap(quote);
  if (!sig) return;

  console.log("✅ Swap Success:", sig);

  const outputUSDC = Number(quote.outAmount) / 1e6;
  const balanceSOL = await connection.getBalance(walletKeypair.publicKey) / LAMPORTS_PER_SOL;

  await logResult(sig, tradeSize, outputUSDC, balanceSOL, "success");
}

// =========================
// MAIN LOOP
// =========================
async function main() {
  console.log("🚀 Bot Launched");

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
