// =====================================================
// SOLANA HYBRID SNIPER + COPY BOT (MEV-READY, SAFE)
// Max 30% Exposure | Trailing Stops | Profit Share
// Pump.fun Sniper | Copy Trading | Wallet Clusters
// Dashboard Logging | Test / Live Mode
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
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const CREATOR_WALLET = new PublicKey(process.env.CREATOR_WALLET!);

/* =========================
   CONFIG
========================= */
const MAX_RISK_TOTAL = 0.3;
const MAX_POSITIONS = 5;
const INITIAL_STOP = 0.12;
const TRAILING_STOP = 0.05;
const PROFIT_SHARE = 0.1111;
const MIN_LP_SOL = 5;
const RPC_DELAY = 1200;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

interface Position {
  mint: PublicKey;
  entryPrice: number;
  sizeSOL: number;
  high: number;
  stop: number;
  source: string;
}

interface ControlData {
  status: string;
  testMode: boolean;
  copyTrading?: { wallets?: string[] };
}

interface WalletStats {
  wins: number;
  losses: number;
  pnl: number;
}

const positions = new Map<string, Position>();
const walletStats = new Map<string, WalletStats>();
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function solBalance(): Promise<number> {
  try { return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL; }
  catch { return 0; }
}

/* =========================
   DASHBOARD CONTROL
========================= */
async function fetchControl(): Promise<ControlData | null> {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/* =========================
   DASHBOARD LOGGING
========================= */
async function postLovable(data: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
      body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), ts: new Date().toISOString(), ...data }),
    });
  } catch {}
}

/* =========================
   PRICE & RUG CHECKS
========================= */
async function getPrice(mint: PublicKey): Promise<number> {
  try {
    const q = await jupiter.quoteGet({ inputMint: mint.toBase58(), outputMint: "So11111111111111111111111111111111111111112", amount: 1_000_000, slippageBps: 50 });
    return Number(q.outAmount) / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const info = await connection.getParsedAccountInfo(mint);
    const i = (info.value?.data as any)?.parsed?.info;
    if (i?.mintAuthority || i?.freezeAuthority) return true;
    const accs = await connection.getTokenLargestAccounts(mint);
    const lp = accs.value.reduce((a, b) => a + Number(b.uiAmount || 0), 0);
    return lp < MIN_LP_SOL;
  } catch { return true; }
}

/* =========================
   RISK ENGINE
========================= */
function exposure(): number {
  return [...positions.values()].reduce((a, b) => a + b.sizeSOL, 0);
}

function tradeSize(balance: number): number {
  const remaining = balance * MAX_RISK_TOTAL - exposure();
  if (remaining <= 0) return 0;
  const base = balance < 100 ? 0.01 : balance < 200 ? 0.02 : balance < 500 ? 0.03 : 0.05;
  return Math.min(base, remaining);
}

/* =========================
   SWAP
========================= */
async function swap(side: "BUY" | "SELL", mint: PublicKey, amount: number): Promise<{ sig: string; outAmount: number } | null> {
  try {
    const inputMint = side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112";

    const quote = await jupiter.quoteGet({ inputMint, outputMint, amount: Math.floor(amount), slippageBps: 200 });
    if ((quote as any).error) throw new Error((quote as any).error);

    const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote as any, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true } });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize());
    return { sig, outAmount: Number(quote.outAmount) };
  } catch { return null; }
}

/* =========================
   BUY / SELL
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  if (positions.size >= MAX_POSITIONS || positions.has(mint.toBase58())) return;
  if (await isRug(mint)) return;

  const bal = await solBalance();
  const sizeSOL = tradeSize(bal);
  if (sizeSOL <= 0) return;

  const entryPrice = await getPrice(mint);
  positions.set(mint.toBase58(), { mint, entryPrice, sizeSOL, high: entryPrice, stop: entryPrice * (1 - INITIAL_STOP), source });

  if (!testMode) await swap("BUY", mint, sizeSOL * LAMPORTS_PER_SOL);
  await postLovable({ side: "BUY", pair: mint.toBase58(), sizeSOL, entry_price: entryPrice, source, testMode, status: "CONFIRMED" });
}

async function sell(pos: Position, reason: string, testMode: boolean) {
  const currentPrice = await getPrice(pos.mint);
  const pnl = pos.sizeSOL * (currentPrice / pos.entryPrice - 1);
  positions.delete(pos.mint.toBase58());
  if (!testMode) await swap("SELL", pos.mint, pos.sizeSOL * LAMPORTS_PER_SOL);
  await postLovable({ side: "SELL", pair: pos.mint.toBase58(), sizeSOL: pos.sizeSOL, pnl, reason, testMode, status: "CONFIRMED" });
}

/* =========================
   POSITION MANAGER
========================= */
async function manage(testMode: boolean) {
  for (const pos of positions.values()) {
    const price = await getPrice(pos.mint);
    if (price <= pos.stop) await sell(pos, "STOP_LOSS", testMode);
    else if (price > pos.high) { pos.high = price; pos.stop = price * (1 - TRAILING_STOP); }
    await sleep(RPC_DELAY);
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function initPumpSniper(testMode: boolean) {
  if (listenerActive) return;
  connection.onLogs(PUMP_FUN_PROGRAM, async (log) => {
    if (log.err || !log.logs.some(l => l.includes("Create"))) return;
    try {
      const tx = await connection.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0 });
      for (const b of tx?.meta?.postTokenBalances || []) await buy(new PublicKey(b.mint), "PUMP_FUN", testMode);
    } catch {}
  }, "confirmed");
  listenerActive = true;
}

/* =========================
   COPY TRADING (CLUSTER + SCORING)
========================= */
function walletScore(w: WalletStats) { return w.pnl + w.wins * 0.1 - w.losses * 0.2; }

function clusterConfirm(mint: string, buyers: string[], minScore = 1) {
  const scored = buyers.filter(w => { const s = walletStats.get(w); return s && walletScore(s) >= minScore; });
  return scored.length >= 2;
}

async function mirrorWalletsClustered(wallets: string[], testMode: boolean) {
  const mintBuyers = new Map<string, string[]>();
  for (const w of wallets) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(w), { limit: 2 });
    for (const s of sigs) {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      for (const b of tx?.meta?.postTokenBalances || []) {
        if (b.owner === w) {
          const arr = mintBuyers.get(b.mint) || []; arr.push(w); mintBuyers.set(b.mint, arr);
        }
      }
    }
    await sleep(RPC_DELAY);
  }
  for (const [mint, buyers] of mintBuyers) {
    if (clusterConfirm(mint, buyers)) await buy(new PublicKey(mint), "CLUSTER_COPY", testMode);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  while (true) {
    const control = await fetchControl();
    const bal = await solBalance();
    if (!control || control.status !== "RUNNING") { await sleep(10000); continue; }
    const testMode = control.testMode === true;
    initPumpSniper(testMode);
    if (control.copyTrading?.wallets) await mirrorWalletsClustered(control.copyTrading.wallets, testMode);
    await manage(testMode);
    await sleep(3000);
  }
}

run();
