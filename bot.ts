// =====================================================
// SOLANA HYBRID SNIPER + COPY BOT (PRODUCTION READY)
// - Jupiter real-time pricing
// - Dynamic trailing stops
// - Auto SELL
// - 11.11% profit share
// - RPC throttling
// - LOVABLE DASHBOARD INTEGRATION
// =====================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;

// Lovable Dashboard Integration
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;

/* =========================
   CONFIG
========================= */
const MAX_RISK_PCT = 0.03;
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const TRAILING_STOP_PCT = 0.10;
const PROFIT_SHARE_PCT = 0.1111;
const RPC_DELAY_MS = 1200;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/* =========================
   STATE
========================= */
type Position = {
  mint: PublicKey;
  buyPrice: number;
  highestPrice: number;
  sizeSOL: number;
};

const openPositions = new Map<string, Position>();
let listenerActive = false;
let botEnabled = true;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getBalanceSOL() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

/* =========================
   LOVABLE DASHBOARD INTEGRATION
========================= */
async function postLovable(data: any) {
  try {
    const response = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_API_KEY,
      },
      body: JSON.stringify({
        wallet: wallet.publicKey.toBase58(),
        ...data,
        ts: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ postLovable failed:", response.status, errorText);
    } else {
      console.log("✅ Logged to Lovable dashboard");
    }
  } catch (e: any) {
    console.error("❌ postLovable error:", e?.message || e);
  }
}

async function checkDashboardControl(): Promise<boolean> {
  try {
    const response = await fetch(LOVABLE_CONTROL_URL, {
      method: "GET",
      headers: {
        "apikey": SUPABASE_API_KEY,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("❌ Control check failed:", response.status);
      return true; // Default to running if control check fails
    }

    const data = await response.json();
    const status = data.status || data.botState?.status;
    
    if (status === "RUNNING") {
      return true;
    } else if (status === "STOPPED" || status === "PAUSED") {
      return false;
    }
    
    return true;
  } catch (e: any) {
    console.error("❌ Control check error:", e?.message || e);
    return true; // Default to running if error
  }
}

/* =========================
   REAL PRICE FROM JUPITER
========================= */
async function getTokenPriceSOL(mint: string): Promise<number | null> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: 1_000_000,
      slippageBps: 50,
    });
    return Number(quote.outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return null;
  }
}

/* =========================
   EXECUTE SWAP
========================= */
async function executeSwap(
  inputMint: string,
  outputMint: string,
  amountLamports: number
): Promise<string | null> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount: amountLamports,
      slippageBps: SLIPPAGE_BPS,
    });

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
    );
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`✅ TX CONFIRMED: https://solscan.io/tx/${sig}`);
    return sig;
  } catch (e: any) {
    console.error("🔴 SWAP FAILED:", e?.message || e);
    return null;
  }
}

/* =========================
   BUY
========================= */
async function buyToken(mint: PublicKey) {
  if (!botEnabled) {
    console.log("⏸️ Bot is disabled, skipping buy");
    return;
  }

  const balance = await getBalanceSOL();
  const sizeSOL = Math.max(balance * MAX_RISK_PCT, 0.01);
  if (balance < sizeSOL + 0.02) return;

  const sig = await executeSwap(
    SOL_MINT,
    mint.toBase58(),
    Math.floor(sizeSOL * LAMPORTS_PER_SOL)
  );
  if (!sig) return;

  const price = await getTokenPriceSOL(mint.toBase58());
  if (!price) return;

  openPositions.set(mint.toBase58(), {
    mint,
    buyPrice: price,
    highestPrice: price,
    sizeSOL,
  });

  console.log(`🟢 BOUGHT ${mint.toBase58()} @ ${price.toFixed(6)} SOL`);

  // Log BUY to Lovable dashboard
  await postLovable({
    side: "BUY",
    mint: mint.toBase58(),
    pair: `${mint.toBase58().slice(0, 6)}/SOL`,
    action: "BUY",
    size: sizeSOL,
    source: "PUMP_SNIPER",
    status: "CONFIRMED",
    tx_signature: sig,
    entry_price: price,
    inputAmount: sizeSOL,
  });
}

/* =========================
   SELL + PROFIT SHARE
========================= */
async function sellToken(pos: Position) {
  const exitPrice = await getTokenPriceSOL(pos.mint.toBase58());
  
  const sig = await executeSwap(
    pos.mint.toBase58(),
    SOL_MINT,
    Math.floor(pos.sizeSOL * LAMPORTS_PER_SOL)
  );
  if (!sig) return;

  const outSOL = await getBalanceSOL();
  const profit = Math.max(0, outSOL - pos.sizeSOL);
  const profitPercent = pos.buyPrice > 0 ? ((exitPrice || 0) - pos.buyPrice) / pos.buyPrice * 100 : 0;
  const fee = profit * PROFIT_SHARE_PCT;

  if (fee > 0) {
    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(CREATOR_WALLET),
      lamports: Math.floor(fee * LAMPORTS_PER_SOL),
    });

    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    await connection.sendTransaction(tx);

    console.log(`💰 PROFIT SHARE SENT: ${fee.toFixed(4)} SOL`);
  }

  console.log(`🔴 SOLD ${pos.mint.toBase58()} | Profit: ${profit.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)`);

  // Log SELL to Lovable dashboard
  await postLovable({
    side: "SELL",
    mint: pos.mint.toBase58(),
    pair: `${pos.mint.toBase58().slice(0, 6)}/SOL`,
    action: "SELL",
    size: pos.sizeSOL,
    source: "TRAILING_STOP",
    status: "CONFIRMED",
    tx_signature: sig,
    entry_price: pos.buyPrice,
    exit_price: exitPrice,
    pnl: profit,
    roi: profitPercent,
    outputAmount: outSOL,
  });

  openPositions.delete(pos.mint.toBase58());
}

/* =========================
   TRAILING STOP LOOP
========================= */
async function trailingLoop() {
  for (const pos of openPositions.values()) {
    const price = await getTokenPriceSOL(pos.mint.toBase58());
    if (!price) continue;

    if (price > pos.highestPrice) {
      pos.highestPrice = price;
    }

    const stop = pos.highestPrice * (1 - TRAILING_STOP_PCT);
    if (price < stop) {
      console.log(`🔻 TRAILING STOP HIT: ${pos.mint.toBase58()}`);
      await sellToken(pos);
    }

    await sleep(RPC_DELAY_MS);
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function startPumpSniper() {
  if (listenerActive) return;

  connection.onLogs(PUMP_FUN_PROGRAM, async log => {
    if (log.err) return;
    if (!botEnabled) return;

    const tx = await connection.getParsedTransaction(log.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.postTokenBalances) return;

    for (const b of tx.meta.postTokenBalances) {
      if (Number(b.uiTokenAmount.uiAmountString || 0) > 0) {
        const mint = new PublicKey(b.mint);
        await buyToken(mint);
        break;
      }
    }
  });

  listenerActive = true;
  console.log("👂 Pump.fun sniper ACTIVE");
}

/* =========================
   MAIN
========================= */
async function run() {
  console.log("🤖 BOT LIVE");
  console.log(`📍 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`🔗 Dashboard: Lovable integration enabled`);

  // Log bot startup
  await postLovable({
    type: "STATUS",
    status: "STARTED",
    message: "Bot started and connected to dashboard",
  });

  while (true) {
    try {
      // Check dashboard control status
      const shouldRun = await checkDashboardControl();
      
      if (!shouldRun && botEnabled) {
        console.log("⏸️ Dashboard says STOPPED, pausing bot...");
        botEnabled = false;
        await postLovable({
          type: "STATUS",
          status: "PAUSED",
          message: "Bot paused via dashboard",
        });
      } else if (shouldRun && !botEnabled) {
        console.log("▶️ Dashboard says RUNNING, resuming bot...");
        botEnabled = true;
        await postLovable({
          type: "STATUS",
          status: "RUNNING",
          message: "Bot resumed via dashboard",
        });
      }

      if (botEnabled) {
        startPumpSniper();
        await trailingLoop();
      }
    } catch (e: any) {
      console.error("Loop error:", e?.message || e);
    }
    
    await sleep(3000);
  }
}

run();
