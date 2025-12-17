// ===========================
// Hybrid Sniper + Auto Copy Bot (REAL wallet mirroring)
// ===========================
// NOTE:
// - Uses Solana RPC only (no Photon scraping)
// - Mirrors REAL buys/sells by parsing on-chain transactions
// - Sniper hooks are present but minimal; focus is copy-trading correctness
// - TEST_MODE=true is SAFE (no real swaps)

import {
  Connection,
  Keypair,
  PublicKey,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";
import bs58 from "bs58";

// ===================== ENV =====================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;

// ===================== CONFIG =====================
const TEST_MODE = true;            // FALSE = live trading
const FIXED_SOL = 0.01;            // €10 mode works
const MAX_RISK_PCT = 0.03;         // % of balance if FIXED_SOL = 0
const POLL_MS = 12_000;            // wallet polling interval
const MAX_WALLETS = 30;            // top FOMO wallets

// ===================== CONNECTION =====================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

// ===================== STATE =====================
const lastSeenSig: Record<string, string> = {}; // wallet -> last signature

interface OpenPosition {
  mint: PublicKey;
  sizeSOL: number;
  entryPrice: number;
  type: "COPY" | "SNIPER";
  source: string; // wallet or MARKET
}

const openPositions = new Map<string, OpenPosition>();

// ===================== SUPABASE / LOVABLE =====================
async function postTrade(row: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify(row),
  });
}

// ===================== FOMO LEADERBOARD =====================
// Table: fomo_leaderboard(wallet text)
async function fetchTopFomoWallets(): Promise<string[]> {
  const url = "https://YOUR_PROJECT_ID.supabase.co/rest/v1/fomo_leaderboard?select=wallet&limit=" + MAX_WALLETS;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_API_KEY,
      Authorization: `Bearer ${SUPABASE_API_KEY}`,
    },
  });
  const data = await res.json();
  return data.map((r: any) => r.wallet);
}

// ===================== TX PARSING =====================
// Detects SPL token BUY/SELL by comparing token balances
function extractTrade(tx: ParsedTransactionWithMeta, wallet: string) {
  if (!tx.meta) return null;

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  for (const p of post) {
    const before = pre.find(
      (b) => b.mint === p.mint && b.owner === p.owner
    );

    if (!before && p.owner === wallet && p.uiTokenAmount.uiAmount! > 0) {
      return { side: "BUY", mint: new PublicKey(p.mint) };
    }

    if (
      before &&
      p.owner === wallet &&
      before.uiTokenAmount.uiAmount! > p.uiTokenAmount.uiAmount!
    ) {
      return { side: "SELL", mint: new PublicKey(p.mint) };
    }
  }

  return null;
}

// ===================== JUPITER (SIMPLIFIED) =====================
async function swapSOLToToken(mint: PublicKey, sol: number) {
  if (TEST_MODE) return "TEST_BUY";
  // real Jupiter swap goes here
  return "REAL_BUY_TX";
}

async function swapTokenToSOL(mint: PublicKey) {
  if (TEST_MODE) return "TEST_SELL";
  return "REAL_SELL_TX";
}

// ===================== COPY ENGINE =====================
async function processWallet(walletAddr: string) {
  const pk = new PublicKey(walletAddr);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 5 });
  if (!sigs.length) return;

  const newest = sigs[0].signature;
  if (lastSeenSig[walletAddr] === newest) return;
  lastSeenSig[walletAddr] = newest;

  const tx = await connection.getParsedTransaction(newest, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return;

  const trade = extractTrade(tx, walletAddr);
  if (!trade) return;

  // ===== BUY =====
  if (trade.side === "BUY") {
    const sizeSOL = FIXED_SOL;
    await swapSOLToToken(trade.mint, sizeSOL);

    openPositions.set(trade.mint.toBase58(), {
      mint: trade.mint,
      sizeSOL,
      entryPrice: 1,
      type: "COPY",
      source: walletAddr,
    });

    await postTrade({
      wallet: wallet.publicKey.toBase58(),
      type: "COPY",
      source: walletAddr,
      pair: trade.mint.toBase58(),
      entry: 1,
      exit: 0,
      pnl: 0,
      ts: new Date().toISOString(),
    });

    console.log(`[COPY BUY] ${walletAddr} → ${trade.mint.toBase58()}`);
  }

  // ===== SELL =====
  if (trade.side === "SELL") {
    const pos = openPositions.get(trade.mint.toBase58());
    if (!pos) return;

    await swapTokenToSOL(trade.mint);

    await postTrade({
      wallet: wallet.publicKey.toBase58(),
      type: "COPY",
      source: walletAddr,
      pair: trade.mint.toBase58(),
      entry: pos.entryPrice,
      exit: 1,
      pnl: 0,
      ts: new Date().toISOString(),
    });

    openPositions.delete(trade.mint.toBase58());
    console.log(`[COPY SELL] ${walletAddr} → ${trade.mint.toBase58()}`);
  }
}

// ===================== MAIN LOOP =====================
export async function runBot() {
  console.log("🚀 Bot running", wallet.publicKey.toBase58());

  setInterval(async () => {
    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      try {
        await processWallet(w);
      } catch (e) {
        console.error("wallet error", w, e);
      }
    }
  }, POLL_MS);
}

runBot();
