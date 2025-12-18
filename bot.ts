// =====================================================
// HYBRID SNIPER + COPY BOT – Volume Monitoring + Multi-Positions
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

/* ENV & CONFIG – same as before */
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
const TAKE_PROFIT_X = 3;
const VOLUME_DROP_PCT = 0.5; // Sell if volume < 50% of peak

/* SETUP */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const seenTx: Set<string> = new Set();
const openPositions: Map<string, {
  buyPrice: number;
  peakVolume: number;
  interval: NodeJS.Timeout;
}> = new Map();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;
let listenerActive = false;
let initialBalance = 0;
let BASE_TRADE_SIZE = 0.01;

/* UTILS – same as before (fetchControl, postLovable, balanceSOL, tradeSize) */

/* VOLUME FROM DEXSCREENER (free public API) */
async function getVolume24h(mint: PublicKey): Promise<number> {
  try {
    const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    const data = await pairRes.json();
    if (data.pairs && data.pairs.length > 0) {
      return data.pairs.reduce((max: number, p: any) => Math.max(max, p.volume?.h24 || 0), 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

/* MONITOR POSITION – Volume + Price */
async function monitorPosition(mintStr: string, buyPrice: number, testMode: boolean) {
  const mint = new PublicKey(mintStr);
  let peakVolume = await getVolume24h(mint);

  const interval = setInterval(async () => {
    const currentPrice = await getCurrentPrice(mint); // Reuse from previous
    const currentVolume = await getVolume24h(mint);
    if (currentVolume > peakVolume) peakVolume = currentVolume;

    // Take Profit
    if (currentPrice >= buyPrice * TAKE_PROFIT_X) {
      console.log(`🎯 TP ${TAKE_PROFIT_X}x hit on ${mintStr}`);
      await trade("SELL", mint, "TAKE_PROFIT", "volume", testMode);
      clearInterval(interval);
      openPositions.delete(mintStr);
      return;
    }

    // Volume Drop Exit
    if (currentVolume < peakVolume * VOLUME_DROP_PCT) {
      console.log(`📉 Volume dropped >50% on ${mintStr} – exiting`);
      await trade("SELL", mint, "VOLUME_DROP", "volume", testMode);
      clearInterval(interval);
      openPositions.delete(mintStr);
    }
  }, 15000); // Every 15s

  openPositions.set(mintStr, { buyPrice, peakVolume, interval });
}

/* TRADE – calls monitor on BUY */
async function trade(...) {
  // ... same as before

  if (side === "BUY" && !testMode) {
    const buyPrice = await getCurrentPrice(mint);
    monitorPosition(mint.toBase58(), buyPrice, testMode);
  }
}

/* MAIN LOOP – same */
