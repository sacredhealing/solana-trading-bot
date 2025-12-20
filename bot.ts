// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025 – INSTITUTIONAL v2
// Lovable Dashboard + Multi-Wallet
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
import { createJupiterApiClient } from "@jup-ag/api";
import Database from "better-sqlite3";
import fetch from "node-fetch";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const EXECUTION_KEYS = process.env.EXECUTION_KEYS!.split(","); // base58[]
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
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
};

/* =========================
   STATE
========================= */
let connection: Connection;
let jupiter: ReturnType<typeof createJupiterApiClient>;

const wallets: Keypair[] = [];
const positions = new Map<string, any>();
const presignedCache = new Map<string, VersionedTransaction>();

/* =========================
   DB (ANALYTICS)
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
   DASHBOARD PUSH
========================= */
function pushDashboard(event: string, payload: any) {
  fetch(LOVABLE_CONTROL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ts: Date.now(),
      event,
      payload,
    }),
  }).catch(() => {});
}

/* =========================
   INIT
========================= */
async function init() {
  connection = new Connection(RPC_URL, { commitment: "processed" as Commitment });

  for (const k of EXECUTION_KEYS) {
    wallets.push(Keypair.fromSecretKey(bs58.decode(k)));
  }

  jupiter = createJupiterApiClient({
    apiKey: JUPITER_API_KEY,
    basePath: "https://quote-api.jup.ag/v6",
  });

  pushDashboard("boot", {
    wallets: wallets.map(w => w.publicKey.toBase58()),
  });

  console.log(`🚀 Loaded ${wallets.length} execution wallets`);
}

/* =========================
   EXPECTANCY
========================= */
function expectancy(source: string): number {
  const s = db.prepare(`SELECT * FROM stats WHERE source=?`).get(source);
  if (!s || s.trades < CONFIG.MIN_TRADES) return 1;
  return (s.wins / s.trades) * (s.pnl / s.wins || -0.01);
}

function walletDisabled(source: string): boolean {
  const s = db.prepare(`SELECT * FROM stats WHERE source=?`).get(source);
  if (!s || s.trades < CONFIG.MIN_TRADES) return false;
  return expectancy(source) < CONFIG.MIN_EXPECTANCY;
}

/* =========================
   PRICE
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
   WALLET SELECTION
========================= */
function selectWallet(source: string): Keypair {
  const bias = Math.max(0.5, Math.min(1.5, expectancy(source)));
  const idx = Math.floor(Math.random() * wallets.length * bias) % wallets.length;
  return wallets[idx];
}

/* =========================
   EXECUTION
========================= */
async function sendTx(tx: VersionedTransaction) {
  await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: USE_JITO,
  });
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  if (walletDisabled(source)) {
    pushDashboard("wallet_disabled", { source });
    return;
  }

  if (positions.has(mint.toBase58())) return;

  const wallet = selectWallet(source);
  const price = await getPrice(mint);
  if (!price) return;

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

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);

  if (!testMode) await sendTx(tx);

  positions.set(mint.toBase58(), {
    mint,
    entry: price,
    high: price,
    stop: price * (1 - CONFIG.INITIAL_STOP),
    source,
    wallet: wallet.publicKey.toBase58(),
  });

  pushDashboard("buy", {
    mint: mint.toBase58(),
    source,
    price,
    wallet: wallet.publicKey.toBase58(),
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

    if (price <= pos.stop) {
      const pnl = price - pos.entry;
      positions.delete(k);

      db.prepare(`
        INSERT INTO stats VALUES (?,?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET
        trades=trades+1,
        wins=wins+?,
        losses=losses+?,
        pnl=pnl+?
      `).run(
        pos.source, 1, pnl > 0 ? 1 : 0, pnl <= 0 ? 1 : 0, pnl,
        pnl > 0 ? 1 : 0, pnl <= 0 ? 1 : 0, pnl
      );

      pushDashboard("exit", {
        mint: k,
        pnl,
        source: pos.source,
        wallet: pos.wallet,
      });

      console.log(`🛑 EXIT ${k.slice(0, 6)} PnL=${pnl.toFixed(4)}`);
      continue;
    }

    if (price > pos.high) {
      pos.high = price;
      pos.stop = price * (1 - CONFIG.TRAILING_STOP);
    }
  }
}

/* =========================
   COPY + PUMP.FUN
========================= */
function startCopyWallet(addr: string, testMode: boolean) {
  const pub = new PublicKey(addr);
  connection.onLogs(pub, async l => {
    if (!l.logs.some(x => x.includes("Swap"))) return;
    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) await buy(new PublicKey(mint), `COPY_${addr.slice(0, 6)}`, testMode);
  });
}

function startPumpSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async l => {
    if (!l.logs.some(x => x.includes("InitializeMint"))) return;
    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) await buy(new PublicKey(mint), "PUMP_FAST", testMode);
  });
}

/* =========================
   MAIN
========================= */
async function run() {
  await init();
  const testMode = false;

  startPumpSniper(testMode);
  startCopyWallet("PASTE_SMART_WALLET", testMode);

  while (true) {
    await manage(testMode);
    await new Promise(r => setTimeout(r, 2000));
  }
}

run();
