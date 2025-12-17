// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// One-file bot.ts – TEST/LIVE controlled by Lovable
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
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!; // Supabase / API

/* =========================
   USER RISK CONFIG
========================= */

const FIXED_SOL = 0;          // 0 = % based
const MAX_RISK_PCT = 0.03;    // 3%
const MIN_TOTAL_USD = 10;     // min starting balance
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
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;

/* =========================
   UTILS
========================= */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchControl() {
  const r = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
  return r.json();
}

async function postLovable(row: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
    body: JSON.stringify(row),
  });
}

async function balanceSOL() {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

function tradeSize(balance: number) {
  return FIXED_SOL > 0 ? FIXED_SOL : Math.max(balance * MAX_RISK_PCT, 0.005);
}

async function hasMinBalance() {
  return (await balanceSOL()) * SOL_PRICE_EST >= MIN_TOTAL_USD;
}

/* =========================
   AUTO FOMO WALLET FETCH
========================= */

async function fetchTopFomoWallets(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFomoRefresh < 6 * 60 * 60 * 1000 && cachedFomoWallets.length) {
    return cachedFomoWallets;
  }

  const r = await fetch(FOMO_WALLET_FEED, { headers: { apikey: SUPABASE_API_KEY } });
  const rows = await r.json();

  cachedFomoWallets = rows
    .map((r: any) => r.wallet)
    .filter((w: string) => {
      try { new PublicKey(w); return true; } catch { return false; }
    })
    .slice(0, 30);

  lastFomoRefresh = now;
  console.log("🔥 Loaded FOMO wallets:", cachedFomoWallets.length);
  return cachedFomoWallets;
}

/* =========================
   RUG CHECKS
========================= */

async function isRug(mint: PublicKey): Promise<boolean> {
  const acc = await connection.getParsedAccountInfo(mint);
  const info: any = (acc.value as any)?.data?.parsed?.info;
  return !!info?.mintAuthority || !!info?.freezeAuthority;
}

/* =========================
   COPY-TRADING (AUTO MIRROR)
========================= */

async function mirrorWallet(addr: string, testMode: boolean) {
  let pub: PublicKey;
  try { pub = new PublicKey(addr); } catch { return; }

  const sigs = await connection.getSignaturesForAddress(pub, { limit: 1 });
  if (!sigs.length) return;

  const sig = sigs[0].signature;
  if (seenTx[addr] === sig) return;
  seenTx[addr] = sig;

  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const bal = tx?.meta?.postTokenBalances?.[0];
  if (!bal) return;

  const mint = new PublicKey(bal.mint);
  if (await isRug(mint)) return;

  if (!openPositions[mint.toBase58()]) {
    await trade("BUY", mint, "COPY", addr, testMode);
    openPositions[mint.toBase58()] = true;
  } else {
    await trade("SELL", mint, "COPY", addr, testMode);
    delete openPositions[mint.toBase58()];
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

function initPumpSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async (l) => {
    const line = l.logs.find(x => x.includes("Create"));
    if (!line) return;

    const mintStr = line.split(" ").pop()!;
    let mint: PublicKey;
    try { mint = new PublicKey(mintStr); } catch { return; }

    if (await isRug(mint)) return;

    await trade("BUY", mint, "SNIPER", "pump.fun", testMode);

    setTimeout(() => trade("SELL", mint, "SNIPER", "pump.fun", testMode), 120000);
  });
}

/* =========================
   EXECUTION
========================= */

async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const size = tradeSize(await balanceSOL());
  console.log(`${testMode ? "🧪" : "🚀"} ${side} ${type}`, mint.toBase58());

  await postLovable({
    wallet: wallet.publicKey.toBase58(),
    type,
    source,
    mint: mint.toBase58(),
    side,
    size,
    ts: new Date().toISOString(),
  });

  if (testMode) return;

  const quote = await jupiter.quoteGet({
    inputMint: side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58(),
    outputMint: side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112",
    amount: Math.round(size * LAMPORTS_PER_SOL),
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

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([wallet]);
  await connection.sendRawTransaction(tx.serialize());
}

/* =========================
   MAIN LOOP
========================= */

async function run() {
  console.log("🤖 HYBRID BOT LIVE");

  while (true) {
    const control = await fetchControl();
    const TEST_MODE = control.testMode === true;

    if (control.status !== "RUNNING" || !(await hasMinBalance())) {
      await sleep(5000);
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
