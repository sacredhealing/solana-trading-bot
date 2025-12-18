// =====================================================
// HYBRID SNIPER + COPY BOT – Fixed Test Mode PnL for Lovable
// Simulated profit/loss sent for dashboard balance update
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

/* ENV & CONFIG – same */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!;

const MAX_RISK_PCT = 0.03;
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE = "auto";
const AUTO_SELL_MINUTES = 10;

/* SETUP – same */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const seenTx: Set<string> = new Set();
const openPositions: Map<string, NodeJS.Timeout> = new Map();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;
let listenerActive = false;

/* UTILS – same (sleep, fetchControl, postLovable, balanceSOL, tradeSize, fetchTopFomoWallets, isRug, mirrorWallet, initPumpSniper) */

/* EXECUTION – Updated with Simulated PnL */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const currentBalance = await balanceSOL();
  let sizeSOL = tradeSize(currentBalance);

  if (isNaN(sizeSOL) || sizeSOL <= 0) sizeSOL = 0.01;

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} | ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  // Simulated PnL for test mode
  let profitSOL = 0;
  let profitPercent = 0;
  if (testMode) {
    profitPercent = Math.random() * 13 - 3; // -3% to +10% random
    profitSOL = sizeSOL * (profitPercent / 100);
  }

  await postLovable({
    wallet: walletKeypair.publicKey.toBase58(),
    type,
    source,
    mint: mint.toBase58(),
    side,
    size: sizeSOL,
    testMode,
    status: testMode ? "simulated" : "pending",
    profitSOL: testMode ? profitSOL.toFixed(4) : 0,
    profitPercent: testMode ? profitPercent.toFixed(2) : 0,
    ts: new Date().toISOString(),
  });

  if (testMode) return;

  // Live low balance skip + real swap (unchanged)
  if (currentBalance < (sizeSOL + 0.02)) {
    console.log(`⚠️ Low balance – skipping live trade`);
    return;
  }

  // ... (rest of live swap code unchanged)
}

/* MAIN LOOP – same */

run();
