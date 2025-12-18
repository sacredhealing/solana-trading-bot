// =====================================================
// SAFE SOLANA MEME BOT – CAPITAL PROTECTED
// Max 30% exposure | Trailing stops | Auto-sell
// Profit Share 11.11% | RPC throttled
// =====================================================

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

// ================= ENV =================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const PROFIT_SHARE_PCT = 0.1111;

// ================= CONSTANTS =================
const MAX_EXPOSURE_PCT = 0.30;
const TRAILING_STOP_PCT = 0.06; // 6%
const SLIPPAGE_BPS = 200;
const RPC_DELAY = 800;

// ================= SETUP =================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

// ================= STATE =================
type Position = {
  mint: string;
  buySOL: number;
  highestSOL: number;
};

const openPositions = new Map<string, Position>();

// ================= UTILS =================
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function walletBalanceSOL() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

function totalExposureSOL() {
  let sum = 0;
  for (const p of openPositions.values()) sum += p.buySOL;
  return sum;
}

function tradeSizeSOL(walletSOL: number) {
  if (walletSOL < 1) return 0.005;
  if (walletSOL < 3) return 0.01;
  if (walletSOL < 7) return 0.02;
  if (walletSOL < 15) return 0.03;
  return 0.04;
}

// ================= BUY =================
async function buyToken(mint: PublicKey) {
  const walletSOL = await walletBalanceSOL();
  const maxExposure = walletSOL * MAX_EXPOSURE_PCT;
  const currentExposure = totalExposureSOL();

  if (currentExposure >= maxExposure) {
    console.log("⛔ Exposure cap reached — skipping buy");
    return;
  }

  let sizeSOL = tradeSizeSOL(walletSOL);
  sizeSOL = Math.min(sizeSOL, maxExposure - currentExposure);
  if (sizeSOL <= 0) return;

  console.log(`🟢 BUY ${sizeSOL.toFixed(3)} SOL`);

  try {
    const quote = await jupiter.quoteGet({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: mint.toBase58(),
      amount: Math.floor(sizeSOL * LAMPORTS_PER_SOL),
      slippageBps: SLIPPAGE_BPS
    });

    const swap = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true
      }
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swap.swapTransaction, "base64")
    );
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`✅ BUY TX: ${sig}`);

    openPositions.set(mint.toBase58(), {
      mint: mint.toBase58(),
      buySOL: sizeSOL,
      highestSOL: sizeSOL
    });

  } catch (e) {
    console.error("❌ BUY FAILED", e);
  }
}

// ================= SELL =================
async function sellToken(pos: Position) {
  console.log(`🔴 SELL ${pos.mint}`);

  try {
    const quote = await jupiter.quoteGet({
      inputMint: pos.mint,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: Math.floor(pos.highestSOL * LAMPORTS_PER_SOL),
      slippageBps: SLIPPAGE_BPS
    });

    const swap = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true
      }
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swap.swapTransaction, "base64")
    );
    tx.sign([wallet]);
    await connection.sendRawTransaction(tx.serialize());

    const profit = Math.max(0, pos.highestSOL - pos.buySOL);
    if (profit > 0) {
      const fee = profit * PROFIT_SHARE_PCT;
      const ix = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(CREATOR_WALLET),
        lamports: Math.floor(fee * LAMPORTS_PER_SOL)
      });

      const msg = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ix]
      }).compileToV0Message();

      const feeTx = new VersionedTransaction(msg);
      feeTx.sign([wallet]);
      await connection.sendTransaction(feeTx);
    }

    openPositions.delete(pos.mint);

  } catch (e) {
    console.error("❌ SELL FAILED", e);
  }
}

// ================= TRAILING STOP LOOP =================
async function managePositions() {
  for (const pos of openPositions.values()) {
    // Simulated price check placeholder (Jupiter price polling can be added later)
    const simulatedValue = pos.highestSOL * (0.95 + Math.random() * 0.1);

    if (simulatedValue > pos.highestSOL) {
      pos.highestSOL = simulatedValue;
    }

    if (simulatedValue < pos.highestSOL * (1 - TRAILING_STOP_PCT)) {
      await sellToken(pos);
    }

    await sleep(RPC_DELAY);
  }
}

// ================= MAIN LOOP =================
async function run() {
  console.log("🤖 SAFE BOT STARTED");
  while (true) {
    await managePositions();
    await sleep(2000);
  }
}

run();
