// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO-SELL MIRROR + PUMP.FUN)
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
   CONFIG
========================= */

const TEST_MODE = true;              // true = demo, false = live
const FIXED_SOL = 0;                 // 0 = use % sizing
const MAX_RISK_PCT = 0.03;           // 3% per trade
const MIN_TOTAL_USD = 10;            // minimum balance
const SOL_PRICE_EST = 150;
const LOOP_MS = 3000;

/* =========================
   ENV
========================= */

const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;

/* =========================
   SETUP
========================= */

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const seenTx: Record<string, string> = {};
const mirrorPositions: Record<string, boolean> = {};

/* =========================
   HELPERS
========================= */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function postLovable(data: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify(data),
  });
}

async function balanceSOL() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

function tradeSize(balance: number) {
  return FIXED_SOL > 0
    ? FIXED_SOL
    : Math.max(balance * MAX_RISK_PCT, 0.005);
}

/* =========================
   RUG CHECKS
========================= */

async function isRug(mint: PublicKey): Promise<boolean> {
  const acc = await connection.getParsedAccountInfo(mint);
  if (!acc.value) return true;
  const info: any = (acc.value as any).data?.parsed?.info;
  return !!info?.freezeAuthority || !!info?.mintAuthority;
}

/* =========================
   COPY-TRADING (AUTO BUY + AUTO SELL)
========================= */

async function fetchTopFomoWallets(): Promise<string[]> {
  return [
    "PUT_REAL_FOMO_WALLET_1",
    "PUT_REAL_FOMO_WALLET_2",
  ];
}

async function mirrorWallet(walletAddr: string) {
  const sigs = await connection.getSignaturesForAddress(
    new PublicKey(walletAddr),
    { limit: 1 }
  );

  if (!sigs.length) return;
  const sig = sigs[0].signature;
  if (seenTx[walletAddr] === sig) return;
  seenTx[walletAddr] = sig;

  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx) return;

  const tokenChange = tx.meta?.postTokenBalances?.[0];
  if (!tokenChange) return;

  const mint = new PublicKey(tokenChange.mint);

  if (await isRug(mint)) return;

  if (!mirrorPositions[mint.toBase58()]) {
    await executeTrade("BUY", mint, walletAddr, "COPY");
    mirrorPositions[mint.toBase58()] = true;
  } else {
    await executeTrade("SELL", mint, walletAddr, "COPY");
    delete mirrorPositions[mint.toBase58()];
  }
}

/* =========================
   PUMP.FUN LIVE SNIPER
========================= */

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

function initPumpSniper() {
  connection.onLogs(PUMP_FUN_PROGRAM, async (logs) => {
    const mintLog = logs.logs.find(l => l.includes("Create"));
    if (!mintLog) return;

    const mint = new PublicKey(mintLog.split(" ").pop()!);
    if (await isRug(mint)) return;

    await executeTrade("BUY", mint, "PUMP_FUN", "SNIPER");

    setTimeout(async () => {
      await executeTrade("SELL", mint, "PUMP_FUN", "SNIPER");
    }, 120000);
  });
}

/* =========================
   EXECUTION
========================= */

async function executeTrade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  source: string,
  type: "COPY" | "SNIPER"
) {
  const bal = await balanceSOL();
  const sizeSOL = tradeSize(bal);

  console.log(`${TEST_MODE ? "🧪" : "🚀"} ${side} ${type}`, mint.toBase58());

  if (TEST_MODE) {
    await postLovable({
      wallet: wallet.publicKey.toBase58(),
      type,
      source,
      mint: mint.toBase58(),
      side,
      size: sizeSOL,
      ts: new Date().toISOString(),
    });
    return;
  }

  const quote = await jupiter.quoteGet({
    inputMint:
      side === "BUY"
        ? "So11111111111111111111111111111111111111112"
        : mint.toBase58(),
    outputMint:
      side === "BUY"
        ? mint.toBase58()
        : "So11111111111111111111111111111111111111112",
    amount: Math.round(sizeSOL * LAMPORTS_PER_SOL),
    slippageBps: 200,
  });

  if ("error" in quote) return;

  const swap = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, "base64")
  );

  tx.sign([wallet]);
  await connection.sendRawTransaction(tx.serialize());
}

/* =========================
   MAIN LOOP
========================= */

async function run() {
  console.log("🤖 HYBRID BOT STARTED", TEST_MODE ? "TEST" : "LIVE");
  initPumpSniper();

  while (true) {
    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w);
    }
    await sleep(LOOP_MS);
  }
}

run();
