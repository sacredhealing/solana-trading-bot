// =====================================================
// TOP 1% SOLANA MEME BOT – ENDGAME EDITION
// Jito Bundles | Signature Copy | Smart Discovery | Multi-Wallet
// =====================================================

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const JITO_RPC_URL = process.env.JITO_RPC_URL || ""; // optional
const JITO_AUTH_KEY = process.env.JITO_AUTH_KEY || "";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_LOG_URL = process.env.LOVABLE_API_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;

// MULTI WALLET
const WALLET_KEYS = (process.env.SOLANA_PRIVATE_KEYS || "")
  .split(",")
  .map(k => Keypair.fromSecretKey(bs58.decode(k)));

/* =========================
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const CONFIG = {
  BASE_SOL: 0.03,
  INITIAL_STOP: 0.18,
  TRAILING_STOP: 0.08,
  MIN_TOKEN_AGE_MS: 60_000,
  MAIN_LOOP_MS: 2000,
};

/* =========================
   STATE
========================= */
const connection = new Connection(RPC_URL, {
  commitment: "processed" as Commitment,
});

const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

let walletIndex = 0;
const positions = new Map<string, any>();
const smartWallets = new Map<string, { trades: number; pnl: number }>();
const copyListeners = new Map<string, number>();

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: any[]) => console.log(new Date().toLocaleTimeString(), ...a);

function nextWallet(): Keypair {
  const w = WALLET_KEYS[walletIndex % WALLET_KEYS.length];
  walletIndex++;
  return w;
}

/* =========================
   JITO BUNDLE SEND (OPTIONAL)
========================= */
async function sendBundle(tx: VersionedTransaction): Promise<boolean> {
  if (!JITO_RPC_URL || !JITO_AUTH_KEY) return false;

  try {
    await fetch(JITO_RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JITO_AUTH_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[tx.serialize().toString("base64")]],
      }),
    });
    log("🧱 JITO BUNDLE SENT");
    return true;
  } catch {
    return false;
  }
}

/* =========================
   TOKEN AGE CHECK
========================= */
async function isOld(mint: PublicKey): Promise<boolean> {
  const sigs = await connection.getSignaturesForAddress(mint, { limit: 1 });
  if (!sigs.length || !sigs[0].blockTime) return true;
  return Date.now() - sigs[0].blockTime * 1000 > CONFIG.MIN_TOKEN_AGE_MS;
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, test: boolean) {
  if (positions.has(mint.toBase58())) return;
  if (await isOld(mint)) return;

  const wallet = nextWallet();
  log("🛒 BUY", mint.toBase58(), "via", source, wallet.publicKey.toBase58());

  if (!test) {
    const q = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: mint.toBase58(),
      amount: CONFIG.BASE_SOL * LAMPORTS_PER_SOL,
      slippageBps: 200,
    });
    if ("error" in q) return;

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: q,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(swapTransaction, "base64")
    );
    tx.sign([wallet]);

    if (!(await sendBundle(tx))) {
      await connection.sendRawTransaction(tx.serialize());
    }
  }

  positions.set(mint.toBase58(), {
    mint,
    wallet: wallet.publicKey.toBase58(),
    entryTime: Date.now(),
    source,
  });
}

/* =========================
   SIGNATURE COPY TRADING
========================= */
function followWallet(addr: string, test: boolean) {
  if (copyListeners.has(addr)) return;

  const sub = connection.onLogs(new PublicKey(addr), async l => {
    const tx = await connection.getParsedTransaction(l.signature, {
      maxSupportedTransactionVersion: 0,
    });
    const mint =
      tx?.meta?.postTokenBalances?.find(b => b.owner !== addr)?.mint;
    if (mint) await buy(new PublicKey(mint), `COPY_${addr.slice(0, 6)}`, test);
  });

  copyListeners.set(addr, sub);
  log("👀 FOLLOWING SMART WALLET", addr);
}

/* =========================
   SMART WALLET DISCOVERY
========================= */
async function discoverWallet(addr: string, pnl: number) {
  const s = smartWallets.get(addr) || { trades: 0, pnl: 0 };
  s.trades++;
  s.pnl += pnl;
  smartWallets.set(addr, s);

  if (s.trades >= 5 && s.pnl > 0) {
    followWallet(addr, false);
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
function startPump(test: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async l => {
    if (!l.logs.some(x => x.includes("InitializeMint"))) return;
    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) await buy(new PublicKey(mint), "PUMP", test);
  });
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  log("🚀 BOT STARTED | Wallets:", WALLET_KEYS.length);

  let sniper = false;

  while (true) {
    try {
      const c = await fetch(LOVABLE_CONTROL_URL, {
        headers: { apikey: SUPABASE_API_KEY },
      }).then(r => r.json());

      const test = c?.testMode ?? true;

      if (!sniper && c?.status === "RUNNING") {
        startPump(test);
        sniper = true;
      }

      await sleep(CONFIG.MAIN_LOOP_MS);
    } catch (e) {
      log("❌ LOOP ERROR", e);
      await sleep(5000);
    }
  }
}

run();
