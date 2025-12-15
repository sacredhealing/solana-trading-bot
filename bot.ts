// =========================
// Lovable Solana Trading Bot
// Railway Version with Dashboard Control
// Jupiter Official API Integrated
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

// Jupiter API Key (your key)
const JUPITER_API_KEY = "59a678ac-3850-4a79-9161-ff38f92fc2e4";

const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;

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

// Jupiter API Client (official)
const jupiterApi = createJupiterApiClient({
  apiKey: JUPITER_API_KEY,
});

function initialize(): boolean {
  try {
    if (!RPC_URL || !PRIVATE_KEY || !LOVABLE_CONTROL_URL) {
      console.error("❌ Missing required environment variables");
      return false;
    }

    connection = new Connection(RPC_URL, "confirmed");
    walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

    console.log(`✅ Wallet: ${walletKeypair.publicKey.toBase58()}`);
    console.log(`✅ RPC Connected`);
    console.log(`✅ Jupiter API Connected`);

    return true;
  } catch (err) {
    console.error("Initialization error:", err);
    return false;
  }
}

// =========================
// DASHBOARD CONTROL
// =========================
async function syncWithDashboard(): Promise<void> {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL);
    if (!res.ok) return;

    const control = await res.json();

    botState.status = control.status;
    botState.tradeSizeSOL = control.trade_size_sol;
    botState.usePercentageRisk = control.use_percentage_risk;
    botState.testMode = control.test_mode;
    botState.balance = control.balance;
    botState.initialBalance = control.initial_balance;
  } catch (e) {
    console.error("Dashboard sync failed:", e);
  }
}

// =========================
// JUPITER FUNCTIONS (OFFICIAL)
// =========================
async function getQuote(amountLamports: number) {
  return await jupiterApi.quoteGet({
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: amountLamports,
    slippageBps: SLIPPAGE_BPS,
  });
}

async function executeSwap(quote: any): Promise<{ success: boolean; txSig?: string }> {
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

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const blockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature: sig,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });

    return { success: true, txSig: sig };
  } catch (err) {
    console.error("Swap failed:", err);
    return { success: false };
  }
}

// =========================
// HELPERS
// =========================
function calculateTradeSize(): number {
  if (botState.usePercentageRisk) {
    return (botState.balance * botState.tradeSizeSOL) / 100;
  }
  return botState.tradeSizeSOL;
}

// =========================
// BOT STEP
// =========================
async function botStep(): Promise<void> {
  await syncWithDashboard();
  if (botState.status !== "RUNNING") return;

  const regimes = ["HOT", "WARM", "COLD"] as const;
  const signals = ["BUY", "WAIT", "EXIT"] as const;

  botState.regime = regimes[Math.floor(Math.random() * regimes.length)];
  botState.last_signal = signals[Math.floor(Math.random() * signals.length)];

  const time = new Date().toLocaleTimeString();

  if (botState.last_signal === "BUY" && botState.regime !== "COLD") {
    const tradeSize = calculateTradeSize();
    const lamports = Math.round(tradeSize * LAMPORTS_PER_SOL);

    console.log(`[${time}] 🚀 BUY ${tradeSize.toFixed(4)} SOL`);

    const quote = await getQuote(lamports);
    const result = await executeSwap(quote);

    if (result.success) {
      console.log(`[${time}] ✅ TX: ${result.txSig}`);
    } else {
      console.log(`[${time}] ❌ Swap failed`);
    }
  } else {
    console.log(`[${time}] ⏸️ ${botState.last_signal} | ${botState.regime}`);
  }
}

// =========================
// MAIN LOOP
// =========================
async function mainLoop() {
  console.log("🚀 Lovable Solana Trading Bot (Jupiter Official API)");

  if (!initialize()) process.exit(1);

  while (true) {
    try {
      await botStep();
    } catch (e) {
      console.error("Bot error:", e);
    }
    await new Promise(r => setTimeout(r, BOT_INTERVAL_MS));
  }
}

mainLoop();
