// =====================================================
// HYBRID SNIPER + COPY BOT (Lovable Controlled)
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

/* =========================
   CONFIG (USER RISK)
========================= */

const FIXED_SOL = 0;           // 0 = % based
const MAX_RISK_PCT = 0.03;     // 3% per trade
const MIN_TOTAL_USD = 10;
const SOL_PRICE_EST = 150;
const LOOP_MS = 3000;

/* =========================
   SETUP
========================= */

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const seenTx: Record<string, string> = {};
const openPositions: Record<string, boolean> = {};

/* =========================
   HELPERS
========================= */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchControl() {
  const res = await fetch(LOVABLE_CONTROL_URL, {
    headers: { apikey: SUPABASE_API_KEY },
  });
  return res.json();
}

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

async function hasMinBalance() {
  const bal = await balanceSOL();
  return bal * SOL_PRICE_EST >= MIN_TOTAL_USD;
}

function tradeSize(balance: number) {
  return FIXED_SOL > 0
    ? FIXED_SOL
    : Math.max(balance * MAX_RISK_PCT, 0.005);
}

/* =========================
   RUG CHECKS (BASIC)
========================= */

async function isRug(mint: PublicKey): Promise<boolean> {
  const acc = await connection.getParsedAccountInfo(mint);
  if (!acc.value) return true;
  const info: any = (acc.value as any).data?.parsed?.info;
  return !!info?.freezeAuthority || !!info?.mintAuthority;
}

/* =========================
   COPY-TRADING
========================= */

async function fetchTopFomoWallets(): Promise<string[]> {
  // Replace with Supabase / Helius / API feed
  return [
    "PUT_WALLET_1",
    "PUT_WALLET_2",
  ];
}

async function mirrorWallet(walletAddr: string, testMode: boolean) {
  const sigs = await connection.getSignaturesForAddress(
    new PublicKey(walletAddr),
    { limit: 1 }
  );

  if (!sigs.length) return;
  const sig = sigs[0].signature;
  if (seenTx[walletAddr] === sig) return;
  seenTx[walletAddr] = sig;

  const tx = await connection.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return;

  const tokenChange = tx.meta?.postTokenBalances?.[0];
  if (!tokenChange) return;

  const mint = new PublicKey(tokenChange.mint);
  if (await isRug(mint)) return;

  if (!openPositions[mint.toBase58()]) {
    await executeTrade("BUY", mint, "COPY", walletAddr, testMode);
    openPositions[mint.toBase58()] = true;
  } else {
    await executeTrade("SELL", mint, "COPY", walletAddr, testMode);
    delete openPositions[mint.toBase58()];
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

function initPumpSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async (logs) => {
    const line = logs.logs.find(l => l.includes("Create"));
    if (!line) return;

    const mint = new PublicKey(line.split(" ").pop()!);
    if (await isRug(mint)) return;

    await executeTrade("BUY", mint, "SNIPER", "pump.fun", testMode);

    setTimeout(async () => {
      await executeTrade("SELL", mint, "SNIPER", "pump.fun", testMode);
    }, 120000);
  });
}

/* =========================
   TRADE EXECUTION
========================= */

async function executeTrade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const bal = await balanceSOL();
  const sizeSOL = tradeSize(bal);

  console.log(
    `${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type}`,
    mint.toBase58()
  );

  if (testMode) {
    await postLovable({
      wallet: wallet.publicKey.toBase58(),
      type,
      source,
      side,
      mint: mint.toBase58(),
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
  console.log("🤖 HYBRID BOT STARTED");

  while (true) {
    const control = await fetchControl();
    const TEST_MODE = control.testMode === true;

    if (control.status !== "RUNNING") {
      await sleep(3000);
      continue;
    }

    if (!(await hasMinBalance())) {
      console.log("⛔ Balance below $10 — paused");
      await sleep(10000);
      continue;
    }

    initPumpSniper(TEST_MODE);

    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w, TEST_MODE);
    }

    await sleep(LOOP_MS);
  }
}

run();
