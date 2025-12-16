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
import { createJupiterApiClient } from '@jup-ag/api';

// =========================
// CONFIGURATION
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL || "";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const LOVABLE_API_URL = process.env.LOVABLE_API_URL || "";
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL || "";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || ""; // Add this to your Railway variables (get free key from https://portal.jup.ag)
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || ""; // Supabase anon key for Lovable endpoints
const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;
const CONTROL_POLL_MS = 2000;

// =========================
// TYPES
// =========================
// Use types from the library where possible, but keep custom for control
interface ControlStatus {
  status: string;
  tradeSize: number;
  usePercentageRisk: boolean;
  testMode: boolean;
  balance: number;
  initialBalance: number;
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
  jupiterOnline: false,
  lastJupiterError: "" as string,
};

// =========================
// INITIALIZATION
// =========================
let connection: Connection;
let walletKeypair: Keypair;
let jupiterApi: ReturnType<typeof createJupiterApiClient>;

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
    if (!JUPITER_API_KEY) {
      console.error("ERROR: JUPITER_API_KEY not set - Get one from https://portal.jup.ag");
      return false;
    }
    connection = new Connection(RPC_URL, "confirmed");
    const decoded = bs58.decode(PRIVATE_KEY);
    walletKeypair = Keypair.fromSecretKey(decoded);
    
    jupiterApi = createJupiterApiClient({ apiKey: JUPITER_API_KEY });
   
    console.log(`✅ Wallet: ${walletKeypair.publicKey.toString()}`);
    console.log(`✅ RPC: ${RPC_URL.slice(0, 40)}...`);
    console.log(`✅ Control URL: ${LOVABLE_CONTROL_URL.slice(0, 50)}...`);
    console.log(`✅ Jupiter API ready`);
   
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SUPABASE_API_KEY) {
      headers["apikey"] = SUPABASE_API_KEY;
    }
    const response = await fetch(LOVABLE_CONTROL_URL, { headers });
    if (!response.ok) {
      console.error("Control endpoint error:", response.status, await response.text());
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
  botState.tradeSizeSOL = control.tradeSize;
  botState.usePercentageRisk = control.usePercentageRisk;
  botState.testMode = control.testMode;
  botState.balance = control.balance;
  botState.initialBalance = control.initialBalance;
}

// =========================
// JUPITER HEALTH CHECK & FUNCTIONS
// =========================
async function checkJupiterHealth(): Promise<boolean> {
  try {
    // Test with a minimal quote request to verify Jupiter API is responding
    const testParams = {
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amount: 1000000, // 0.001 SOL in lamports
      slippageBps: SLIPPAGE_BPS,
    };
    const quote = await jupiterApi.quoteGet(testParams);
    if ('error' in quote) {
      botState.jupiterOnline = false;
      botState.lastJupiterError = `Quote error: ${JSON.stringify(quote)}`;
      return false;
    }
    botState.jupiterOnline = true;
    botState.lastJupiterError = "";
    return true;
  } catch (error: any) {
    botState.jupiterOnline = false;
    botState.lastJupiterError = error?.message || String(error);
    return false;
  }
}

async function getQuote(amountLamports: number): Promise<any | null> {
  try {
    const params = {
      inputMint: INPUT_MINT,
      outputMint: OUTPUT_MINT,
      amount: amountLamports,
      slippageBps: SLIPPAGE_BPS,
    };
    console.log(`📡 Requesting quote for ${amountLamports} lamports...`);
    const quote = await jupiterApi.quoteGet(params);
    if ('error' in quote) {
      const errMsg = JSON.stringify(quote);
      console.error("❌ Quote error:", errMsg);
      botState.lastJupiterError = errMsg;
      botState.jupiterOnline = false;
      return null;
    }
    botState.jupiterOnline = true;
    console.log(`✅ Quote received: ${quote.outAmount} output amount`);
    return quote;
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.error("❌ Failed to get quote:", errMsg);
    botState.lastJupiterError = errMsg;
    botState.jupiterOnline = false;
    return null;
  }
}

async function executeSwap(quote: any): Promise<{ success: boolean; txSig?: string; error?: string }> {
  try {
    console.log(`🔄 Preparing swap transaction...`);
    const params = {
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      },
    };
    
    console.log(`📡 Requesting swap from Jupiter...`);
    const swapResponse = await jupiterApi.swapPost(params);
    const { swapTransaction } = swapResponse;
    
    if (!swapTransaction) {
      const errMsg = `No swap transaction returned: ${JSON.stringify(swapResponse)}`;
      console.error(`❌ ${errMsg}`);
      botState.lastJupiterError = errMsg;
      return { success: false, error: errMsg };
    }
    
    console.log(`✅ Swap transaction received, signing...`);
    const transactionBuffer = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    transaction.sign([walletKeypair]);
    
    console.log(`📤 Broadcasting transaction to Solana...`);
    const txSig = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    console.log(`⏳ Confirming transaction: ${txSig}`);
    
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature: txSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    
    console.log(`✅ Transaction confirmed!`);
    return { success: true, txSig };
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.error("❌ Swap execution error:", errMsg);
    
    // Provide more specific error diagnosis
    if (errMsg.includes("insufficient")) {
      console.error("💡 Hint: Insufficient SOL balance for this trade");
    } else if (errMsg.includes("0x1") || errMsg.includes("custom program error")) {
      console.error("💡 Hint: Slippage tolerance exceeded or liquidity issue");
    } else if (errMsg.includes("blockhash")) {
      console.error("💡 Hint: Transaction expired, RPC may be slow");
    } else if (errMsg.includes("429") || errMsg.includes("rate")) {
      console.error("💡 Hint: Rate limited - consider adding delays between requests");
    }
    
    botState.lastJupiterError = errMsg;
    return { success: false, error: errMsg };
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SUPABASE_API_KEY) {
      headers["apikey"] = SUPABASE_API_KEY;
    }
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers,
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
        console.log(`[${timestamp}] 📝 TX: https://solscan.io/tx/${result.txSig}`);
        botState.trades++;
        botState.wins++;
        await logToLovable(result.txSig, tradeSize, outputUSDC, balanceSOL, "success");
      } else {
        // Log the actual error instead of just showing "Jupiter unavailable"
        console.log(`[${timestamp}] 🔴 SWAP FAILED | Error: ${result.error || botState.lastJupiterError}`);
        
        // Only fallback to simulation if testMode is enabled
        if (botState.testMode) {
          const change = (Math.random() * 5 - 2) / 100;
          const newBalance = botState.balance * (1 + change);
          console.log(`[${timestamp}] 🟡 TEST MODE SIM ${(change * 100).toFixed(2)}%`);
          await logToLovable("sim", tradeSize, tradeSize * (1 + change), newBalance, change > 0 ? "success" : "failed");
        } else {
          botState.trades++;
          botState.losses++;
          await logToLovable("failed", tradeSize, 0, botState.balance, "failed");
        }
      }
    } else {
      console.log(`[${timestamp}] ⚠️ Could not get quote | Last error: ${botState.lastJupiterError}`);
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
  console.log(" Lovable Solana Trading Bot - Railway Edition");
  console.log("=".repeat(50));
  if (!initialize()) {
    console.error("❌ Failed to initialize. Check environment variables.");
    process.exit(1);
  }
  
  // Check Jupiter API connectivity on startup
  console.log("\n🔍 Checking Jupiter API connectivity...");
  const jupiterHealthy = await checkJupiterHealth();
  if (jupiterHealthy) {
    console.log("✅ Jupiter API is ONLINE and responding");
  } else {
    console.error("⚠️ Jupiter API check failed:", botState.lastJupiterError);
    console.error("⚠️ Bot will continue but trades may fail until Jupiter is reachable");
  }
  
  // Check wallet balance
  try {
    const balanceLamports = await connection.getBalance(walletKeypair.publicKey);
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;
    console.log(`💰 Wallet balance: ${balanceSOL.toFixed(4)} SOL`);
    if (balanceSOL < 0.01) {
      console.warn("⚠️ Warning: Very low SOL balance - trades may fail");
    }
  } catch (error) {
    console.error("⚠️ Could not fetch wallet balance:", error);
  }
  
  console.log("\n🚀 Bot started - Waiting for dashboard commands...");
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
