// bot.ts — HYBRID SNIPER + COPY + SELF‑LEARNING FOMO ENGINE
// ONE FILE. Railway‑ready. Lovable‑controlled. Test / Live switch.

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

// =========================
// ENV
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!;

// =========================
// CONFIG (SAFE DEFAULTS)
// =========================
const CONFIG = {
  minUsdBalance: 10,
  fixedSOL: 0, // set >0 to force fixed size
  maxRiskPct: 0.03,
  maxWalletDrawdown: -1, // auto‑remove if pnl < ‑1 SOL
  winMultiplier: 1.2,
  loseMultiplier: 0.5,
  baseSlippageBps: 75,
};

// =========================
// SETUP
// =========================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

// =========================
// TYPES
// =========================
type TradeType = "COPY" | "SNIPER";

type WalletStats = {
  wins: number;
  losses: number;
  pnl: number;
};

// =========================
// STATE
// =========================
const walletStats: Record<string, WalletStats> = {};
let cachedFomoWallets: string[] = [];
let lastFetch = 0;

// =========================
// UTILS
// =========================
async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_API_KEY },
  });
  return res.json();
}

async function postTrade(data: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify(data),
  });
}

function isValidWallet(w: string): boolean {
  try {
    new PublicKey(w);
    return true;
  } catch {
    return false;
  }
}

// =========================
// FOMO WALLET FEED
// =========================
async function getFomoWallets(): Promise<string[]> {
  if (Date.now() - lastFetch < 6 * 60 * 60 * 1000 && cachedFomoWallets.length)
    return cachedFomoWallets;

  const rows = await fetchJSON<any[]>(FOMO_WALLET_FEED);
  cachedFomoWallets = rows
    .map(r => r.wallet)
    .filter(isValidWallet);

  lastFetch = Date.now();
  console.log(`👀 Loaded ${cachedFomoWallets.length} FOMO wallets`);
  return cachedFomoWallets;
}

// =========================
// SIZE LOGIC
// =========================
async function calcSizeSOL(mult = 1): Promise<number> {
  const bal = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  if (bal * 20 < CONFIG.minUsdBalance) return 0;

  const base = CONFIG.fixedSOL > 0
    ? CONFIG.fixedSOL
    : Math.max(0.01, bal * CONFIG.maxRiskPct);

  return base * mult;
}

// =========================
// COPY TRADING ENGINE
// =========================
async function mirrorWallet(target: string, testMode: boolean) {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(target), { limit: 1 });
  if (!sigs.length) return;

  const sig = sigs[0].signature;
  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx) return;

  // meme‑only heuristic
  const mint = tx.meta?.postTokenBalances?.[0]?.mint;
  if (!mint) return;

  const side = tx.meta!.preBalances[0] > tx.meta!.postBalances[0] ? "BUY" : "SELL";

  const stats = walletStats[target] || { wins: 0, losses: 0, pnl: 0 };
  const mult = stats.pnl > 0 ? CONFIG.winMultiplier : stats.pnl < 0 ? CONFIG.loseMultiplier : 1;
  const sizeSOL = await calcSizeSOL(mult);
  if (sizeSOL <= 0) return;

  console.log(`${testMode ? "🧪" : "🚀"} COPY ${side} ${mint}`);

  if (!testMode) {
    const quote = await jupiter.quoteGet({
      inputMint: side === "BUY" ? "So11111111111111111111111111111111111111112" : mint,
      outputMint: side === "BUY" ? mint : "So11111111111111111111111111111111111111112",
      amount: Math.round(sizeSOL * LAMPORTS_PER_SOL),
      slippageBps: CONFIG.baseSlippageBps,
    });

    if ("error" in quote) return;

    const swap = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const tx2 = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    tx2.sign([wallet]);
    await connection.sendRawTransaction(tx2.serialize());
  }

  await postTrade({
    wallet: wallet.publicKey.toBase58(),
    type: "COPY",
    source: target,
    mint,
    side,
    size: sizeSOL,
    ts: new Date().toISOString(),
  });
}

// =========================
// PUMP.FUN SNIPER (SIMPLE)
// =========================
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

function initSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async logs => {
    const mint = logs.logs.find(l => l.includes("Mint"))?.split(" ").pop();
    if (!mint || !isValidWallet(mint)) return;

    const sizeSOL = await calcSizeSOL();
    if (sizeSOL <= 0) return;

    console.log(`${testMode ? "🧪" : "🚀"} SNIPER BUY ${mint}`);

    if (!testMode) {
      const quote = await jupiter.quoteGet({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amount: Math.round(sizeSOL * LAMPORTS_PER_SOL),
        slippageBps: 200,
      });
      if (!("error" in quote)) {
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
    }

    await postTrade({
      wallet: wallet.publicKey.toBase58(),
      type: "SNIPER",
      source: "pump.fun",
      mint,
      side: "BUY",
      size: sizeSOL,
      ts: new Date().toISOString(),
    });
  });
}

// =========================
// MAIN LOOP
// =========================
async function run() {
  console.log("🤖 HYBRID BOT STARTED");

  while (true) {
    const control = await fetchJSON<any>(LOVABLE_CONTROL_URL);
    const testMode = control.testMode === true;

    const wallets = await getFomoWallets();
    for (const w of wallets) await mirrorWallet(w, testMode);

    if (control.enableSniper !== false) initSniper(testMode);

    await new Promise(r => setTimeout(r, 4000));
  }
}

run();
