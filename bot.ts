// =========================
// Lovable Solana Trading Bot (LIVE-SAFE)
// =========================
// Fixes applied:
// 1. One-shot signal consumption (prevents repeated buys/sells)
// 2. Position awareness (SOL vs USDC)
// 3. Safe test-mode isolation
// 4. Basic Jupiter backoff protection

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
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
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || "";

const INPUT_MINT = "So11111111111111111111111111111111111111112"; // SOL
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

const SLIPPAGE_BPS = 50;
const BOT_INTERVAL_MS = 3000;
const JUPITER_BACKOFF_MS = 15000;

// =========================
// TYPES
// =========================
interface ControlStatus {
  status: string;
  tradeSize: number;
  usePercentageRisk: boolean;
  testMode: boolean;
  balance: number;
  initialBalance: number;
  lastSignal?: string;
  regime?: string;
}

// =========================
// BOT STATE
// =========================
let botState = {
  balance: 0,
  initialBalance: 0,
  trades: 0,
  wins: 0,
  losses: 0,

  status: "STOPPED" as "RUNNING" | "STOPPED",
  regime: "HOT" as "HOT" | "WARM" | "COLD",
  last_signal: "WAIT" as "BUY" | "WAIT" | "EXIT" | "SELL",

  position: "SOL" as "SOL" | "USDC",

  testMode: false,
  tradeSizeSOL: 0.1,
  usePercentageRisk: false,

  jupiterOnline: true,
  lastJupiterError: "",
  lastJupiterFailTs: 0,
};

// =========================
// INITIALIZATION
// =========================
let connection: Connection;
let walletKeypair: Keypair;
let jupiterApi: ReturnType<typeof createJupiterApiClient>;

function initialize(): void {
  if (!RPC_URL || !PRIVATE_KEY || !LOVABLE_CONTROL_URL || !JUPITER_API_KEY) {
    throw new Error("Missing required environment variables");
  }

  connection = new Connection(RPC_URL, "confirmed");
  walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  jupiterApi = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

  console.log(`✅ Wallet: ${walletKeypair.publicKey.toBase58()}`);
}

// =========================
// DASHBOARD SYNC
// =========================
async function syncWithDashboard(): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SUPABASE_API_KEY) headers["apikey"] = SUPABASE_API_KEY;

  const res = await fetch(LOVABLE_CONTROL_URL, { headers });
  if (!res.ok) return;

  const c = (await res.json()) as ControlStatus;
  botState.status = c.status as any;
  botState.tradeSizeSOL = c.tradeSize;
  botState.usePercentageRisk = c.usePercentageRisk;
  botState.testMode = c.testMode;
  botState.balance = c.balance;
  botState.initialBalance = c.initialBalance;

  if (c.lastSignal) botState.last_signal = c.lastSignal as any;
  if (c.regime) botState.regime = c.regime as any;
}

// =========================
// HELPERS
// =========================
function consumeSignal() {
  botState.last_signal = "WAIT";
}

function calculateTradeSize(): number {
  return botState.usePercentageRisk
    ? (botState.balance * botState.tradeSizeSOL) / 100
    : botState.tradeSizeSOL;
}

async function getUsdcBalance(): Promise<number> {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    walletKeypair.publicKey,
    { mint: new PublicKey(OUTPUT_MINT) }
  );

  if (!accounts.value.length) return 0;

  return Math.max(
    ...accounts.value.map(a =>
      parseInt(a.account.data.parsed.info.tokenAmount.amount)
    )
  );
}

// =========================
// JUPITER
// =========================
async function getQuote(params: any) {
  if (!botState.jupiterOnline && Date.now() - botState.lastJupiterFailTs < JUPITER_BACKOFF_MS) {
    return null;
  }

  try {
    const q = await jupiterApi.quoteGet(params);
    if ("error" in q) throw new Error(JSON.stringify(q));
    botState.jupiterOnline = true;
    return q;
  } catch (e: any) {
    botState.jupiterOnline = false;
    botState.lastJupiterFailTs = Date.now();
    botState.lastJupiterError = e.message;
    return null;
  }
}

async function executeSwap(quote: any) {
  const swap = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    },
  });

  if (!swap.swapTransaction) throw new Error("No swap tx");

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([walletKeypair]);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// =========================
// BOT STEP
// =========================
async function botStep() {
  await syncWithDashboard();
  if (botState.status !== "RUNNING") return;

  const ts = new Date().toLocaleTimeString();

  // BUY
  if (botState.last_signal === "BUY" && botState.position === "SOL" && botState.regime !== "COLD") {
    const size = calculateTradeSize();
    const lamports = Math.round(size * LAMPORTS_PER_SOL);

    console.log(`[${ts}] BUY ${size} SOL → USDC`);

    if (!botState.testMode) {
      const quote = await getQuote({ inputMint: INPUT_MINT, outputMint: OUTPUT_MINT, amount: lamports, slippageBps: SLIPPAGE_BPS });
      if (!quote) return;

      await executeSwap(quote);
      botState.position = "USDC";
    }

    botState.trades++;
    botState.wins++;
    consumeSignal();
    return;
  }

  // SELL
  if ((botState.last_signal === "SELL" || botState.last_signal === "EXIT") && botState.position === "USDC") {
    console.log(`[${ts}] SELL USDC → SOL`);

    if (!botState.testMode) {
      const usdc = await getUsdcBalance();
      if (usdc <= 0) return;

      const quote = await getQuote({ inputMint: OUTPUT_MINT, outputMint: INPUT_MINT, amount: usdc, slippageBps: SLIPPAGE_BPS });
      if (!quote) return;

      await executeSwap(quote);
      botState.position = "SOL";
    }

    botState.trades++;
    botState.wins++;
    consumeSignal();
    return;
  }

  console.log(`[${ts}] WAIT | Signal=${botState.last_signal} | Position=${botState.position}`);
}

// =========================
// MAIN
// =========================
async function main() {
  initialize();
  console.log("🚀 Bot started");

  while (true) {
    try {
      await botStep();
    } catch (e) {
      console.error("Bot error", e);
    }
    await new Promise(r => setTimeout(r, BOT_INTERVAL_MS));
  }
}

main();
