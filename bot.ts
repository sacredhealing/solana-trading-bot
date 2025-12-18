// =====================================================
// HYBRID SNIPER + COPY BOT – Volume Monitoring + Multi-Positions + Bubble Maps Anti-Rug
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
const TAKE_PROFIT_X = 3;
const VOLUME_DROP_PCT = 0.5;
const BUBBLE_MAPS_RUG_THRESHOLD = 20; // % top holder – if >20%, skip

/* SETUP – same */

/* VOLUME FROM DEXSCREENER */
async function getVolume24h(mint: PublicKey): Promise<number> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    const data = await r.json();
    return data.pairs?.reduce((max: number, p: any) => Math.max(max, p.volume?.h24 || 0), 0) || 0;
  } catch {
    return 0;
  }
}

/* BUBBLE MAPS RUG CHECK (Free API) */
async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const r = await fetch(`https://api.bubblemaps.io/solana/clusters/${mint.toBase58()}`);
    const data = await r.json();
    const topHolderPct = data.clusters?.[0]?.percent || 0;
    return topHolderPct > BUBBLE_MAPS_RUG_THRESHOLD;
  } catch {
    return true; // Safe skip on error
  }
}

/* MONITOR POSITION – Volume + Price */
async function monitorPosition(mintStr: string, buyPrice: number, testMode: boolean) {
  const mint = new PublicKey(mintStr);
  let peakVolume = await getVolume24h(mint);

  const interval = setInterval(async () => {
    const price = await getCurrentPrice(mint);
    const volume = await getVolume24h(mint);
    if (volume > peakVolume) peakVolume = volume;

    if (price >= buyPrice * TAKE_PROFIT_X) {
      console.log(`🎯 TP hit at ${TAKE_PROFIT_X}x`);
      await trade("SELL", mint, "TAKE_PROFIT", "auto", testMode);
      clearInterval(interval);
      openPositions.delete(mintStr);
      return;
    }

    if (volume < peakVolume * VOLUME_DROP_PCT) {
      console.log(`📉 Volume drop >${VOLUME_DROP_PCT*100}% – exit`);
      await trade("SELL", mint, "VOLUME_DROP", "auto", testMode);
      clearInterval(interval);
      openPositions.delete(mintStr);
    }
  }, 15000); // 15s check

  openPositions.set(mintStr, { buyPrice, peakVolume, interval: interval });
}

/* TRADE – Calls monitor on BUY */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: string,
  source: string,
  testMode: boolean
) {
  const currentBalance = await balanceSOL();
  let sizeSOL = tradeSize(currentBalance);

  if (isNaN(sizeSOL) || sizeSOL <= 0) {
    sizeSOL = 0.01;
  }

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
  });

  if (testMode) return;

  if (currentBalance < (sizeSOL + 0.02)) {
    console.log("Low balance – skip");
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
    console.log(`✅ Tx: https://solscan.io/tx/${sig}`);

    if (side === "BUY") {
      const buyPrice = await getCurrentPrice(mint);
      monitorPosition(mint.toBase58(), buyPrice, testMode);
    }
  } catch (e: any) {
    console.error(`❌ Trade failed: ${e.message}`);
  }
}

/* MAIN LOOP – same as before */

run();
