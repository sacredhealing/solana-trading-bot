// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// Updated: Dynamic Trade Size Scaling with Balance Growth
// =====================================================
import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
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

/* =========================
   USER RISK CONFIG
========================= */
const MAX_RISK_PCT = 0.03; // Max 3% risk cap
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE = "auto";
const AUTO_SELL_MINUTES = 10;
const SIMULATED_TRADE_SIZE = 0.01;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const seenTx: Set<string> = new Set();
const openPositions: Map<string, NodeJS.Timeout> = new Map();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;
let listenerActive = false;
let initialBalance = 0; // For scaling

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchControl() {
  try {
    const r = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
    if (!r.ok) return { status: "STOPPED", testMode: true, tradeSize: 0.01 };
    return await r.json();
  } catch {
    return { status: "STOPPED", testMode: true, tradeSize: 0.01 };
  }
}

async function postLovable(row: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
      body: JSON.stringify(row),
    });
  } catch {}
}

async function balanceSOL() {
  try {
    return (await connection.getBalance(walletKeypair.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

function tradeSize(currentBalance: number, baseSize: number) {
  // Scale fixed baseSize with balance growth (e.g., double balance = double size)
  const growthFactor = initialBalance > 0 ? currentBalance / initialBalance : 1;
  let scaledSize = baseSize * growthFactor;
  return Math.min(scaledSize, currentBalance * MAX_RISK_PCT); // Cap at max risk
}

/* =========================
   FOMO WALLETS
========================= */
async function fetchTopFomoWallets(): Promise<string[]> {
  // ... (unchanged from previous)
}

/* =========================
   RUG CHECK
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  return false;
}

/* =========================
   COPY-TRADING
========================= */
async function mirrorWallet(addr: string, testMode: boolean) {
  // ... (unchanged from previous)
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function initPumpSniper(testMode: boolean) {
  // ... (unchanged from previous)
}

/* =========================
   EXECUTION
========================= */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean,
  baseTradeSize: number
) {
  const currentBalance = await balanceSOL();
  let sizeSOL = tradeSize(currentBalance, baseTradeSize);

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} | ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  await postLovable({
    wallet: walletKeypair.publicKey.toBase58(),
    type,
    source,
    mint: mint.toBase58(),
    side,
    size: sizeSOL,
    testMode,
    status: testMode ? "simulated" : "pending",
    ts: new Date().toISOString(),
    walletConnected: true, // For UI stability
  });

  if (testMode) return;

  if (currentBalance < (sizeSOL + 0.02)) {
    console.log(`⚠️ Low balance – skipping live trade`);
    return;
  }

  try {
    const inputMint = side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112";
    const amount = side === "BUY" ? Math.round(sizeSOL * LAMPORTS_PER_SOL) : undefined;

    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount,
      slippageBps: SLIPPAGE_BPS,
    });

    if ("error" in quote) throw new Error(quote.error as string);

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: PRIORITY_FEE,
      },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([walletKeypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    console.log(`✅ Tx sent: https://solscan.io/tx/${sig}`);
  } catch (e: any) {
    console.error(`❌ ${side} failed: ${e.message || e}`);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 HYBRID MEME BOT WITH DYNAMIC SIZING");

  initialBalance = await balanceSOL(); // Set base for scaling

  while (true) {
    const control = await fetchControl();
    const testMode = control.testMode === true;
    const baseTradeSize = control.tradeSize || 0.01; // From dashboard

    const currentBal = await balanceSOL();
    if (control.status !== "RUNNING" || currentBal < MIN_SOL_BALANCE) {
      console.log(`⏸ Paused – Status: ${control.status}, Balance: ${currentBal.toFixed(4)} SOL`);
      await sleep(10000);
      continue;
    }

    initPumpSniper(testMode);

    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w, testMode);
      await sleep(500);
    }

    await sleep(3000);
  }
}

run();
