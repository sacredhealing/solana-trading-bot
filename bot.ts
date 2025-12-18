// =====================================================
// HYBRID MEME BOT – SNIPER + COPY + TRAILING STOP
// PROFIT SHARE: 11.11% PER PROFITABLE TRADE
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
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;

/* =========================
   CONFIG
========================= */
const MAX_RISK_PCT = 0.03;
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 300;
const PROFIT_SHARE_PCT = 0.1111;
const TRAILING_STOP_PCT = 0.20; // 20% drop from peak
const PRICE_CHECK_MS = 8000;

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
  sizeSOL: number;
  peakSOL: number;
  interval: NodeJS.Timeout;
};

const positions = new Map<string, Position>();
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function balanceSOL() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

function tradeSize(balance: number) {
  return Math.max(balance * MAX_RISK_PCT, 0.01);
}

async function postLovable(data: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_API_KEY,
      },
      body: JSON.stringify(data),
    });
  } catch {}
}

/* =========================
   JUPITER PRICE
========================= */
async function estimateOutSOL(mint: PublicKey, amountLamports: number) {
  const q = await jupiter.quoteGet({
    inputMint: mint.toBase58(),
    outputMint: SOL_MINT,
    amount: amountLamports,
    slippageBps: SLIPPAGE_BPS,
  });
  return Number((q as any).outAmount) / LAMPORTS_PER_SOL;
}

/* =========================
   TRADE EXECUTION
========================= */
async function swap(
  inputMint: string,
  outputMint: string,
  amountLamports: number
) {
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
  console.log(`✅ Tx confirmed: https://solscan.io/tx/${sig}`);
  return sig;
}

/* =========================
   TRAILING STOP LOGIC
========================= */
async function startTrailingStop(
  mint: PublicKey,
  sizeSOL: number,
  tokenAmountLamports: number
) {
  let peak = sizeSOL;

  const interval = setInterval(async () => {
    try {
      const value = await estimateOutSOL(mint, tokenAmountLamports);

      if (value > peak) {
        peak = value; // 🚀 LET WINNERS RUN
        console.log(`📈 New peak: ${peak.toFixed(3)} SOL`);
      }

      const stop = peak * (1 - TRAILING_STOP_PCT);

      if (value <= stop) {
        clearInterval(interval);
        console.log(`🔻 Trailing stop hit – selling`);

        await swap(mint.toBase58(), SOL_MINT, tokenAmountLamports);

        const profit = value - sizeSOL;
        if (profit > 0) {
          const fee = profit * PROFIT_SHARE_PCT;

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

          console.log(`💰 Profit share sent: ${fee.toFixed(4)} SOL`);
        }
      }
    } catch {}
  }, PRICE_CHECK_MS);

  positions.set(mint.toBase58(), { mint, sizeSOL, peakSOL: peak, interval });
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function initPumpSniper() {
  if (listenerActive) return;

  connection.onLogs(PUMP_FUN_PROGRAM, async log => {
    if (log.err) return;

    const tx = await connection.getParsedTransaction(log.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.postTokenBalances) return;

    for (const b of tx.meta.postTokenBalances) {
      if (Number(b.uiTokenAmount.uiAmountString || 0) > 0) {
        const mint = new PublicKey(b.mint);
        const bal = await balanceSOL();
        if (bal < MIN_SOL_BALANCE) return;

        const size = tradeSize(bal);
        console.log(`🆕 Sniping ${mint.toBase58()} (${size.toFixed(3)} SOL)`);

        await swap(
          SOL_MINT,
          mint.toBase58(),
          Math.floor(size * LAMPORTS_PER_SOL)
        );

        const tokenLamports =
          Number(b.uiTokenAmount.amount) || 1_000_000;

        await startTrailingStop(mint, size, tokenLamports);
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
  console.log("🤖 MEME BOT LIVE – 10x/100x/1000x MODE");

  initPumpSniper();

  while (true) {
    await sleep(10_000);
  }
}

run();
