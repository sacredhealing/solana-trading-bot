// ===========================
// Hybrid Sniper + Auto Copy Bot
// ===========================
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createJupiterApiClient } from "@jup-ag/api";
import bs58 from "bs58";

// ===================== ENV =====================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;

// ===================== CONFIG =====================
const TEST_MODE = true; // toggle false for live
const MAX_RISK_PCT = 0.03;
const FIXED_SOL = 0.01;
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOP_FOMO_LIMIT = 30;

// ===================== STATE =====================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

interface OpenPosition { 
  mint: PublicKey; 
  sizeSOL: number; 
  entryPriceSOL: number; 
  peakPriceSOL: number; 
  entryTs: number; 
  type: "SNIPER" | "COPY"; 
  source: string; 
}
const openPositions: Map<string, OpenPosition> = new Map();

// ===================== UTILS =====================
async function postPnL(trade: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
    body: JSON.stringify(trade),
  });
}

async function getQuoteSOLToToken(mint: PublicKey, sizeSOL: number) { return { inAmountSOL: sizeSOL, outAmountSOL: sizeSOL }; }
async function getQuoteTokenToSOL(mint: PublicKey, sizeSOL: number) { return { inAmountSOL: sizeSOL, outAmountSOL: sizeSOL }; }
async function executeSwap(_quote: any) { if (TEST_MODE) return "TEST_TX"; return "REAL_TX_SIG"; }
async function fetchPriceSOL(_mint: PublicKey) { return 1; }
async function isRugRiskHigh(_mint: PublicKey) { return false; }

// ===================== FETCH TOP FOMO WALLETS =====================
async function fetchTopFomoWallets(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://YOUR_SUPABASE_PROJECT_URL/rest/v1/fomo_leaderboard?select=wallet&order=score.desc&limit=30", 
      { headers: { apikey: SUPABASE_API_KEY, Authorization: `Bearer ${SUPABASE_API_KEY}` } }
    );
    const data = await res.json();
    return data.map((row: any) => row.wallet);
  } catch (e) {
    console.error("Failed to fetch top FOMO wallets:", e);
    return [];
  }
}

// ===================== PUMP FUN SNIPER =====================
function initPumpFunSniper() {
  connection.onLogs(PUMP_FUN_PROGRAM, async (logs) => {
    const mint = parseMintFromLogs(logs);
    if (!mint) return;
    const sizeSOL = FIXED_SOL > 0 ? FIXED_SOL : MAX_RISK_PCT;
    await tryTrade(mint, sizeSOL, "SNIPER", "MARKET");
  }, "confirmed");
}
function parseMintFromLogs(_logs: any): PublicKey | null { return null; }

// ===================== EXECUTE TRADE =====================
async function tryTrade(mint: PublicKey, sizeSOL: number, type: "SNIPER" | "COPY", source: string) {
  const quote = await getQuoteSOLToToken(mint, sizeSOL);
  const txSig = await executeSwap(quote);
  const entryPriceSOL = quote.outAmountSOL / quote.inAmountSOL;

  openPositions.set(mint.toBase58(), { mint, sizeSOL, entryPriceSOL, peakPriceSOL: entryPriceSOL, entryTs: Date.now(), type, source });

  await postPnL({
    wallet: wallet.publicKey.toBase58(),
    type,
    source,
    pair: mint.toBase58(),
    entry: entryPriceSOL,
    exit: 0,
    pnl: 0,
    txSig,
    ts: new Date().toISOString(),
  });

  console.log(`[${type}] BUY | Source=${source} | Pair=${mint.toBase58()} | Size=${sizeSOL} | Tx=${txSig}`);
}

// ===================== MONITOR & EXIT =====================
async function monitorExits() {
  for (const [key, pos] of openPositions) {
    const price = await fetchPriceSOL(pos.mint);
    pos.peakPriceSOL = Math.max(pos.peakPriceSOL, price);
    const pnlX = price / pos.entryPriceSOL;
    const drawdown = (pos.peakPriceSOL - price) / pos.peakPriceSOL;

    if (pnlX >= 2 || drawdown >= 0.1) {
      const quote = await getQuoteTokenToSOL(pos.mint, pos.sizeSOL);
      const txSig = await executeSwap(quote);

      await postPnL({
        wallet: wallet.publicKey.toBase58(),
        type: pos.type,
        source: pos.source,
        pair: pos.mint.toBase58(),
        entry: pos.entryPriceSOL,
        exit: price,
        pnl: price - pos.entryPriceSOL,
        txSig,
        ts: new Date().toISOString(),
      });

      console.log(`[EXIT] Pair=${pos.mint.toBase58()} | ExitPrice=${price} | Tx=${txSig}`);
      openPositions.delete(key);
    }
  }
}

// ===================== AUTO COPY TOP FOMO =====================
async function copyTopFomo() {
  const topWallets = await fetchTopFomoWallets();
  for (const fomoWallet of topWallets) {
    try {
      const mint = new PublicKey("FAKE_MINT"); // replace with actual logic per wallet
      const sizeSOL = FIXED_SOL > 0 ? FIXED_SOL : MAX_RISK_PCT;
      await tryTrade(mint, sizeSOL, "COPY", fomoWallet);
    } catch (e) {
      console.error("Copy failed:", fomoWallet, e);
    }
  }
}

// ===================== MAIN LOOP =====================
export async function runBot() {
  console.log("🚀 Bot started");
  initPumpFunSniper();
  setInterval(monitorExits, 10000);   // monitor open positions
  setInterval(copyTopFomo, 15000);    // fetch & copy top FOMO wallets
}
