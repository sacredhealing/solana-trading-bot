// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025 – LIVE READY
// Fixes:
// 1) Log raw Lovable control payload
// 2) Robust copyTrading.wallets parsing
// 3) Correct pump.fun mint extraction
// 4) Lovable heartbeat updates
// 5) Strict testMode enforcement (LIVE only if boolean false)
// =====================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import { createJupiterApiClient } from "@jup-ag/api";
import Database from "better-sqlite3";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_TELEMETRY_URL = process.env.LOVABLE_TELEMETRY_URL!;
const USE_JITO = process.env.USE_JITO === "true";

/* =========================
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const CONFIG = {
  BASE_TRADE_SOL: 0.03,
  INITIAL_STOP: 0.15,
  TRAILING_STOP: 0.07,
  MIN_EXPECTANCY: -0.02,
  MIN_TRADES: 6,
  HEARTBEAT_MS: 10000,
};

/* =========================
   STATE
========================= */
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;
const positions = new Map<
  string,
  {
    mint: PublicKey;
    entry: number;
    high: number;
    stop: number;
    source: string;
    sizeMult: number;
    lastPrice?: number;
  }
>();
const presignedCache = new Map<string, VersionedTransaction>();
let lastHeartbeat = 0;

/* =========================
   DB (PERSISTENT ANALYTICS)
========================= */
const db = new Database("trades.db");
db.exec(`
CREATE TABLE IF NOT EXISTS stats (
  source TEXT PRIMARY KEY,
  trades INTEGER,
  wins INTEGER,
  losses INTEGER,
  pnl REAL
)`);

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getLovableControl(): Promise<any> {
  const res = await fetch(LOVABLE_CONTROL_URL, { method: "GET" });
  const json = await res.json();
  // 1️⃣ LOG RAW CONTROL PAYLOAD
  console.log("📡 RAW LOVABLE CONTROL:", JSON.stringify(json, null, 2));
  return json;
}

async function postLovable(payload: any) {
  try {
    await fetch(LOVABLE_TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("Lovable telemetry failed:", (e as Error).message);
  }
}

/* =========================
   INIT
========================= */
async function init() {
  connection = new Connection(RPC_URL, { commitment: "processed" as Commitment });
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  jupiter = createJupiterApiClient({
    apiKey: JUPITER_API_KEY,
    basePath: "https://quote-api.jup.ag/v6",
  });
  console.log(`🚀 Wallet ${wallet.publicKey.toBase58()}`);
}

/* =========================
   EXPECTANCY + AUTO-DISABLE
========================= */
function recordTrade(source: string, pnl: number) {
  const row = db.prepare(`SELECT * FROM stats WHERE source=?`).get(source);
  if (!row) {
    db.prepare(`INSERT INTO stats VALUES (?,?,?,?,?)`)
      .run(source, 1, pnl > 0 ? 1 : 0, pnl <= 0 ? 1 : 0, pnl);
  } else {
    db.prepare(`
      UPDATE stats SET
      trades=trades+1,
      wins=wins+?,
      losses=losses+?,
      pnl=pnl+?
      WHERE source=?
    `).run(pnl > 0 ? 1 : 0, pnl <= 0 ? 1 : 0, pnl, source);
  }
}

function expectancy(source: string): number {
  const s = db.prepare(`SELECT * FROM stats WHERE source=?`).get(source);
  if (!s || s.trades < CONFIG.MIN_TRADES) return 1;
  return (s.wins / s.trades) * (s.pnl / Math.max(s.wins, 1));
}

function walletDisabled(source: string): boolean {
  const s = db.prepare(`SELECT * FROM stats WHERE source=?`).get(source);
  if (!s || s.trades < CONFIG.MIN_TRADES) return false;
  return expectancy(source) < CONFIG.MIN_EXPECTANCY;
}

/* =========================
   PRICE (SOL NORMALIZED)
========================= */
async function getPrice(mint: PublicKey): Promise<number> {
  const solIn = 0.1 * LAMPORTS_PER_SOL;
  const q = await jupiter.quoteGet({
    inputMint: SOL_MINT,
    outputMint: mint.toBase58(),
    amount: solIn,
    slippageBps: 50,
  });
  if ("error" in q) return 0;
  return solIn / Number(q.outAmount);
}

/* =========================
   JITO / PRIVATE EXECUTION (HOOK)
========================= */
async function sendTx(tx: VersionedTransaction) {
  await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: USE_JITO,
  });
}

/* =========================
   PRE-SIGNED TX CACHE
========================= */
async function buildPresignedBuy(mint: PublicKey) {
  const quote = await jupiter.quoteGet({
    inputMint: SOL_MINT,
    outputMint: mint.toBase58(),
    amount: CONFIG.BASE_TRADE_SOL * LAMPORTS_PER_SOL,
    slippageBps: 150,
  });
  if ("error" in quote) return;

  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);
  presignedCache.set(mint.toBase58(), tx);
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  if (walletDisabled(source)) return;
  if (positions.has(mint.toBase58())) return;

  const sizeMult = Math.min(1.5, Math.max(0.5, expectancy(source)));
  const price = await getPrice(mint);
  if (!price) return;

  let tx = presignedCache.get(mint.toBase58());
  if (!tx) {
    await buildPresignedBuy(mint);
    tx = presignedCache.get(mint.toBase58());
  }

  if (!testMode && tx) await sendTx(tx);

  positions.set(mint.toBase58(), {
    mint,
    entry: price,
    high: price,
    stop: price * (1 - CONFIG.INITIAL_STOP),
    source,
    sizeMult,
    lastPrice: price,
  });

  await postLovable({
    type: "BUY",
    mint: mint.toBase58(),
    source,
    price,
    testMode,
  });

  console.log(`🛒 BUY ${mint.toBase58().slice(0, 6)} via ${source}`);
}

/* =========================
   POSITION MANAGER
========================= */
async function manage(testMode: boolean) {
  for (const [k, pos] of positions) {
    const price = await getPrice(pos.mint);
    if (!price) continue;
    pos.lastPrice = price;

    if (price <= pos.stop) {
      recordTrade(pos.source, price - pos.entry);
      positions.delete(k);

      await postLovable({
        type: "SELL",
        mint: k,
        price,
        pnl: price - pos.entry,
        testMode,
      });

      console.log(`🛑 EXIT ${k.slice(0, 6)}`);
      continue;
    }

    if (price > pos.high) {
      pos.high = price;
      pos.stop = price * (1 - CONFIG.TRAILING_STOP);
    }
  }
}

/* =========================
   COPY TRADING
========================= */
function parseCopyWallets(control: any): string[] {
  // 2️⃣ ROBUST PARSING
  return (
    control?.copyTrading?.wallets ||
    control?.copy_wallets ||
    control?.wallets ||
    []
  );
}

function startCopyWallet(addr: string, testMode: boolean) {
  const pub = new PublicKey(addr);
  connection.onLogs(pub, async l => {
    if (!l.logs.some(x => x.includes("Swap"))) return;
    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.find(
      b => b.mint && b.mint !== SOL_MINT
    )?.mint;
    if (mint) await buy(new PublicKey(mint), `COPY_${addr.slice(0, 6)}`, testMode);
  });
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function startPumpSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async l => {
    if (!l.logs.some(x => x.includes("InitializeMint"))) return;
    const tx = await connection.getParsedTransaction(l.signature);
    // 3️⃣ CORRECT MINT EXTRACTION
    const mint = tx?.meta?.postTokenBalances?.find(
      b => b.mint && b.mint !== SOL_MINT
    )?.mint;
    if (mint) await buy(new PublicKey(mint), "PUMP_FAST", testMode);
  });
}

/* =========================
   HEARTBEAT
========================= */
async function heartbeat(testMode: boolean) {
  const now = Date.now();
  if (now - lastHeartbeat < CONFIG.HEARTBEAT_MS) return;
  lastHeartbeat = now;

  await postLovable({
    type: "HEARTBEAT",
    status: "RUNNING",
    testMode,
    wallet: wallet.publicKey.toBase58(),
    positions: [...positions.values()].map(p => ({
      mint: p.mint.toBase58(),
      entry: p.entry,
      last: p.lastPrice,
      stop: p.stop,
      source: p.source,
    })),
  });
}

/* =========================
   MAIN
========================= */
async function run() {
  await init();

  let pumpStarted = false;
  const activeCopyListeners = new Set<string>();

  while (true) {
    const control = await getLovableControl();

    // 5️⃣ STRICT testMode
    if (typeof control?.testMode !== "boolean") {
      console.warn("⚠️ testMode missing or invalid. Defaulting to TEST.");
    }
    const testMode = control?.testMode === false ? false : true;

    if (control?.status !== "RUNNING") {
      await sleep(2000);
      continue;
    }

    // Start pump sniper once
    if (!pumpStarted) {
      startPumpSniper(testMode);
      pumpStarted = true;
    }

    // Copy wallets
    const wallets = parseCopyWallets(control);
    for (const w of wallets) {
      if (!activeCopyListeners.has(w)) {
        startCopyWallet(w, testMode);
        activeCopyListeners.add(w);
      }
    }

    await manage(testMode);
    await heartbeat(testMode);
    await sleep(2000);
  }
}

run().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
