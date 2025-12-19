// =====================================================
// SOLANA HYBRID SNIPER + COPY BOT (429-HARDENED)
// Single-file, production-safe
// - Global RPC rate limiter + queue
// - WS de-dup + backoff
// - Polling fallbacks
// - 30% max exposure, auto pause
// - Trailing + initial stops
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
const RPC_URLS = (process.env.SOLANA_RPC_URLS || process.env.SOLANA_RPC_URL || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!RPC_URLS.length) throw new Error("No RPC URLs provided");

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
const LOOP_DELAY_MS = 3000;

// HARD LIMITS (ANTI-429)
const RPC_QPS = 4;                 // total req/s across bot
const RPC_BURST = 6;               // short burst
const WS_RECONNECT_BASE = 5000;    // ms
const WS_RECONNECT_MAX = 60000;    // ms

/* =========================
   GLOBAL RATE LIMITER
========================= */
class RateLimiter {
  private queue: (() => Promise<any>)[] = [];
  private tokens = RPC_BURST;
  private last = Date.now();

  constructor(private qps: number) {
    setInterval(() => this.refill(), 250).unref();
  }

  private refill() {
    const now = Date.now();
    const delta = now - this.last;
    this.last = now;
    this.tokens = Math.min(RPC_BURST, this.tokens + (delta / 1000) * this.qps);
    this.drain();
  }

  private drain() {
    while (this.tokens >= 1 && this.queue.length) {
      this.tokens -= 1;
      const fn = this.queue.shift()!;
      fn().catch(() => {});
    }
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
      this.drain();
    });
  }
}

const limiter = new RateLimiter(RPC_QPS);

/* =========================
   RPC POOL (ROUND-ROBIN)
========================= */
let rpcIndex = 0;
const connections = RPC_URLS.map(
  u => new Connection(u, { commitment: "confirmed", wsEndpoint: u.replace(/^http/, "ws") })
);
function conn() {
  const c = connections[rpcIndex % connections.length];
  rpcIndex++;
  return c;
}

/* =========================
   SETUP
========================= */
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

const positions = new Map<string, Position>();
let wsActive = false;
let wsBackoff = WS_RECONNECT_BASE;

/* =========================
   UTILS (RATE-LIMITED)
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rl<T>(fn: () => Promise<T>): Promise<T> {
  return limiter.schedule(fn);
}

async function solBalance(): Promise<number> {
  return rl(async () => (await conn().getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL)
    .catch(() => 0);
}

/* =========================
   DASHBOARD
========================= */
async function fetchControl(): Promise<ControlData | null> {
  try {
    const r = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

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
    const q = await jupiter.quoteGet({
      inputMint: mint.toBase58(),
      outputMint: "So11111111111111111111111111111111111111112",
      amount: 1_000_000,
      slippageBps: 50,
    });
    return Number(q.outAmount) / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const info = await rl(() => conn().getParsedAccountInfo(mint));
    const i = (info.value?.data as any)?.parsed?.info;
    if (i?.mintAuthority || i?.freezeAuthority) return true;

    const accs = await rl(() => conn().getTokenLargestAccounts(mint));
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
   SWAPS (RATE-LIMITED)
========================= */
async function swap(
  side: "BUY" | "SELL",
  mint: PublicKey,
  amountLamports: number
): Promise<{ sig: string; outAmount: number } | null> {
  try {
    const inputMint = side === "BUY"
      ? "So11111111111111111111111111111111111111112"
      : mint.toBase58();
    const outputMint = side === "BUY"
      ? mint.toBase58()
      : "So11111111111111111111111111111111111111112";

    const quote = await jupiter.quoteGet({
      inputMint, outputMint, amount: Math.floor(amountLamports), slippageBps: 200
    });

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);

    const sig = await rl(() => conn().sendRawTransaction(tx.serialize(), { skipPreflight: true }));
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
  const pos: Position = {
    mint,
    entryPrice,
    sizeSOL,
    high: entryPrice,
    stop: entryPrice * (1 - INITIAL_STOP),
    source,
  };
  positions.set(mint.toBase58(), pos);

  if (!testMode) await swap("BUY", mint, sizeSOL * LAMPORTS_PER_SOL);
  await postLovable({ side: "BUY", pair: mint.toBase58(), sizeSOL, entry_price: entryPrice, source, testMode });
}

async function sell(pos: Position, reason: string, testMode: boolean) {
  const price = await getPrice(pos.mint);
  const pnl = pos.sizeSOL * (price / pos.entryPrice - 1);
  positions.delete(pos.mint.toBase58());

  if (!testMode) {
    const res = await swap("SELL", pos.mint, pos.sizeSOL * LAMPORTS_PER_SOL);
    if (pnl > 0 && res) {
      const share = Math.floor(pnl * PROFIT_SHARE * LAMPORTS_PER_SOL);
      if (share > 0) {
        await rl(() => conn().requestAirdrop(CREATOR_WALLET, 0).catch(() => {})); // no-op keep rate
      }
    }
  }

  await postLovable({ side: "SELL", pair: pos.mint.toBase58(), pnl, reason, testMode });
}

/* =========================
   POSITION MANAGER
========================= */
async function manage(testMode: boolean) {
  for (const pos of positions.values()) {
    const price = await getPrice(pos.mint);
    if (price <= pos.stop) await sell(pos, "STOP", testMode);
    else if (price > pos.high) {
      pos.high = price;
      pos.stop = price * (1 - TRAILING_STOP);
    }
    await sleep(250);
  }
}

/* =========================
   PUMP.FUN SNIPER (WS SAFE)
========================= */
function initPumpSniper(testMode: boolean) {
  if (wsActive) return;
  try {
    const c = conn();
    const sub = c.onLogs(PUMP_FUN_PROGRAM, async (log) => {
      if (log.err || !log.logs?.some(l => l.includes("Create"))) return;
      try {
        const tx = await rl(() =>
          c.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0 })
        );
        for (const b of tx?.meta?.postTokenBalances || []) {
          await buy(new PublicKey(b.mint), "PUMP_FUN", testMode);
        }
      } catch {}
    }, "confirmed");

    wsActive = true;
    wsBackoff = WS_RECONNECT_BASE;

    c._rpcWebSocket?.on("close", async () => {
      wsActive = false;
      await sleep(wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, WS_RECONNECT_MAX);
      initPumpSniper(testMode);
    });
  } catch {
    wsActive = false;
  }
}

/* =========================
   COPY TRADING (POLLING)
========================= */
async function mirrorWallets(wallets: string[], testMode: boolean) {
  for (const w of wallets) {
    try {
      const sigs = await rl(() =>
        conn().getSignaturesForAddress(new PublicKey(w), { limit: 1 })
      );
      for (const s of sigs) {
        const tx = await rl(() =>
          conn().getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
        );
        for (const b of tx?.meta?.postTokenBalances || []) {
          if (b.owner === w) await buy(new PublicKey(b.mint), "COPY", testMode);
        }
      }
    } catch {}
    await sleep(400);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  while (true) {
    const control = await fetchControl();
    if (!control || control.status !== "RUNNING") {
      await sleep(10000);
      continue;
    }
    const testMode = control.testMode === true;
    initPumpSniper(testMode);
    if (control.copyTrading?.wallets?.length) {
      await mirrorWallets(control.copyTrading.wallets, testMode);
    }
    await manage(testMode);
    await sleep(LOOP_DELAY_MS);
  }
}

run();
