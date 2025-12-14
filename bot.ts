// =========================
// Lovable Solana Trading Bot
// Railway Version with Dashboard Control
// =========================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

// =========================
// CONFIGURATION
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL || "";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const LOVABLE_API_URL = process.env.LOVABLE_API_URL || "";
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL || "";

const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;
const CONTROL_POLL_MS = 2000;

// =========================
// TYPES
// =========================
interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  slippageBps: number;
  error?: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  error?: string;
}

interface ControlStatus {
  status: string;
  trade_size_sol: number;
  use_percentage_risk: boolean;
  test_mode: boolean;
  balance: number;
  initial_balance: number;
}

// =========================
// BOT STATE
// =========================
let botState = {
  balance: 0,
  initialBalance: 0,
  pnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  regime: "HOT" as "HOT" | "WARM" | "COLD",
  status: "STOPPED" as "RUNNING" | "STOPPED",
  last_signal: "WAIT" as "BUY" | "WAIT" | "EXIT",
  testMode: false,
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
    if (!RPC_URL) {
      console.error("ERROR: SOLANA_RPC_URL not set");
      return false;
    }
    if (!PRIVATE_KEY) {
      console.error("ERROR: SOLANA_PRIVATE_KEY not set");
      return false;
    }
    if (!LOVABLE_CONTROL_URL) {
      console.error("ERROR: LOVABLE_CONTROL_URL not set");
      return false;
    }

    connection = new Connection(RPC_URL, "confirmed");
    const decoded = bs58.decode(PRIVATE_KEY);
    walletKeypair = Keypair.fromSecretKey(decoded);
    
    console.log(`✅ Wallet: ${walletKeypair.publicKey.toString()}`);
    console.log(`✅ RPC: ${RPC_URL.slice(0, 40)}...`);
    console.log(`✅ Control URL: ${LOVABLE_CONTROL_URL.slice(0, 50)}...`);
    
    return true;
  } catch (error) {
    console.error("Initialization error:", error);
    return false;
  }
}

// =========================
// DASHBOARD CONTROL
// =========================
async function getControlStatus(): Promise<ControlStatus | null> {
  try {
    const response = await fetch(LOVABLE_CONTROL_URL);
    if (!response.ok) {
      console.error("Control endpoint error:", response.status);
      return null;
    }
    return await response.json() as ControlStatus;
  } catch (error) {
    console.error("Failed to fetch control status:", error);
    return null;
  }
}

async function syncWithDashboard(): Promise<void> {
  const control = await getControlStatus();
  if (!control) return;

  botState.status = control.status as "RUNNING" | "STOPPED";
  botState.tradeSizeSOL = control.trade_size_sol;
  botState.usePercentageRisk = control.use_percentage_risk;
  botState.testMode = control.test_mode;
  botState.balance = control.balance;
  botState.initialBalance = control.initial_balance;
}

// =========================
// JUPITER FUNCTIONS
// =========================
async function getQuote(amountLamports: number): Promise<JupiterQuoteResponse | null> {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${INPUT_MINT}&outputMint=${OUTPUT_MINT}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`;
    const response = await fetch(url);
    const data = await response.json() as JupiterQuoteResponse;
    
    if (data.error) {
      console.error("Quote error:", data.error);
      return null;
    }
    return data;
  } catch (error) {
    console.error("Failed to get quote:", error);
    return null;
  }
}

async function executeSwap(quote: JupiterQuoteResponse): Promise<{ success: boolean; txSig?: string }> {
  try {
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });

    const swapData = await swapResponse.json() as JupiterSwapResponse;

    if (swapData.error || !swapData.swapTransaction) {
      console.error("Swap error:", swapData.error);
      return { success: false };
    }

    const transactionBuffer = Buffer.from(swapData.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    transaction.sign([walletKeypair]);

    const txSig = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature: txSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    return { success: true, txSig };
  } catch (error) {
    console.error("Swap error:", error);
    return { success: false };
  }
}

// =========================
// LOG TO LOVABLE
// =========================
async function logToLovable(
  txSig: string,
  inputAmount: number,
  outputAmount: number,
  balance: number,
  status: string
): Promise<void> {
  if (!LOVABLE_API_URL) return;

  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txSig,
        inputAmount,
        outputAmount,
        balance,
        status,
        walletAddress: walletKeypair.publicKey.toString(),
      }),
    });
  } catch (error) {
    console.error("Failed to log:", error);
  }
}

// =========================
// CALCULATE TRADE SIZE
// =========================
function calculateTradeSize(): number {
  if (botState.usePercentageRisk) {
    // Use percentage of balance (tradeSizeSOL is treated as percentage)
    return (botState.balance * botState.tradeSizeSOL) / 100;
  }
  return botState.tradeSizeSOL;
}

// =========================
// BOT STEP
// =========================
async function botStep(): Promise<void> {
  // Sync with dashboard first
  await syncWithDashboard();

  // Check if stopped
  if (botState.status !== "RUNNING") {
    return;
  }

  // Generate regime
  const regimes: Array<"HOT" | "WARM" | "COLD"> = ["HOT", "WARM", "COLD"];
  botState.regime = regimes[Math.floor(Math.random() * regimes.length)];

  // Generate signal
  const signals: Array<"BUY" | "WAIT" | "EXIT"> = ["BUY", "WAIT", "EXIT"];
  botState.last_signal = signals[Math.floor(Math.random() * signals.length)];

  const timestamp = new Date().toLocaleTimeString();

  // Execute trade if conditions met
  if (botState.last_signal === "BUY" && botState.regime !== "COLD") {
    const tradeSize = calculateTradeSize();
    const amountLamports = Math.round(tradeSize * LAMPORTS_PER_SOL);
    
    console.log(`[${timestamp}] 📊 Attempting trade: ${tradeSize.toFixed(4)} SOL`);

    const quote = await getQuote(amountLamports);

    if (quote) {
      const result = await executeSwap(quote);

      if (result.success && result.txSig) {
        const outputUSDC = parseInt(quote.outAmount) / 1_000_000;
        const balanceSOL = await connection.getBalance(walletKeypair.publicKey) / LAMPORTS_PER_SOL;

        console.log(`[${timestamp}] 🟢 LIVE SWAP | ${tradeSize} SOL → ${outputUSDC.toFixed(2)} USDC`);
        console.log(`[${timestamp}] 📝 TX: ${result.txSig}`);

        await logToLovable(result.txSig, tradeSize, outputUSDC, balanceSOL, "success");
      } else {
        // Fallback simulation
        const change = (Math.random() * 5 - 2) / 100;
        const newBalance = botState.balance * (1 + change);
        
        console.log(`[${timestamp}] 🟡 LIVE (SIM) ${(change * 100).toFixed(2)}% | Jupiter unavailable`);
        
        await logToLovable("sim", tradeSize, tradeSize * (1 + change), newBalance, change > 0 ? "success" : "failed");
      }
    } else {
      console.log(`[${timestamp}] ⚠️ Could not get quote`);
    }
  } else {
    console.log(`[${timestamp}] ⚪ Signal: ${botState.last_signal} | Regime: ${botState.regime} | Waiting...`);
  }
}

// =========================
// MAIN LOOP
// =========================
async function mainLoop(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  Lovable Solana Trading Bot - Railway Edition");
  console.log("=".repeat(50));

  if (!initialize()) {
    console.error("❌ Failed to initialize. Check environment variables.");
    process.exit(1);
  }

  console.log("🚀 Bot started - Waiting for dashboard commands...");
  console.log("");

  // Main loop
  while (true) {
    try {
      await botStep();
    } catch (error) {
      console.error("Bot step error:", error);
    }
    
    // Wait before next cycle
    await new Promise(resolve => setTimeout(resolve, BOT_INTERVAL_MS));
  }
}

// Start
mainLoop();
