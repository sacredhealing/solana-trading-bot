// =====================================================
// SOLANA SNIPER BOT — LOVABLE CONTROLLED (HEADLESS SAFE)
// =====================================================

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import fetch from "node-fetch";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const LOVABLE_URL = process.env.LOVABLE_CONTROL_URL!;
const SUPABASE_KEY = process.env.SUPABASE_API_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

/* =========================
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const CONFIG = {
  TRADE_SOL: 0.03,
  STOP_LOSS: 0.25,
  TRAILING_STOP: 0.12,
  CONTROL_POLL_MS: 3000,
};

/* =========================
   STATE
========================= */
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;

let botRunning = false;
let testMode = true;
let sniperActive = false;

const positions = new Map<string, any>();

/* =========================
   INIT
========================= */
async function init() {
  connection = new Connection(RPC_URL, "processed");

  const key = bs58.decode(PRIVATE_KEY);
  if (key.length !== 64) throw new Error("Bad private key size");

  wallet = Keypair.fromSecretKey(key);
  jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

  console.log("🤖 BOT ONLINE");
  console.log("Wallet:", wallet.publicKey.toBase58());
}

/* =========================
   LOVABLE CONTROL
========================= */
async function fetchControl() {
  try {
    const res = await fetch(LOVABLE_URL, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    const data = await res.json();
    return data?.[0] || null;
  } catch {
    return null;
  }
}

/* =========================
   PRICE
========================= */
async function price(mint: PublicKey): Promise<number> {
  const q = await jupiter.quoteGet({
    inputMint: SOL_MINT,
    outputMint: mint.toBase58(),
    amount: 0.1 * LAMPORTS_PER_SOL,
    slippageBps: 50,
  });
  if ("error" in q) return 0;
  return (0.1 * LAMPORTS_PER_SOL) / Number(q.outAmount);
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey) {
  if (positions.has(mint.toBase58())) return;

  if (testMode) {
    console.log("🟡 TEST BUY", mint.toBase58().slice(0, 6));
    positions.set(mint.toBase58(), { mint, entry: 1, high: 1, stop: 0.75 });
    return;
  }

  const q = await jupiter.quoteGet({
    inputMint: SOL_MINT,
    outputMint: mint.toBase58(),
    amount: CONFIG.TRADE_SOL * LAMPORTS_PER_SOL,
    slippageBps: 300,
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
  await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

  const p = await price(mint);
  positions.set(mint.toBase58(), {
    mint,
    entry: p,
    high: p,
    stop: p * (1 - CONFIG.STOP_LOSS),
  });

  console.log("🛒 LIVE BUY", mint.toBase58().slice(0, 6));
}

/* =========================
   POSITION MANAGER
========================= */
async function manage() {
  for (const [k, p] of positions) {
    const pr = await price(p.mint);
    if (!pr) continue;

    if (pr <= p.stop) {
      console.log("🔴 EXIT", k.slice(0, 6));
      positions.delete(k);
      continue;
    }

    if (pr > p.high) {
      p.high = pr;
      p.stop = pr * (1 - CONFIG.TRAILING_STOP);
    }
  }
}

/* =========================
   PUMP.FUN LISTENER
========================= */
function startSniper() {
  if (sniperActive) return;

  connection.onLogs(PUMP_FUN_PROGRAM, async (l) => {
    if (!botRunning) return;
    if (!l.logs.some((x) => x.includes("InitializeMint"))) return;

    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) await buy(new PublicKey(mint));
  });

  sniperActive = true;
  console.log("🎯 SNIPER ACTIVE");
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  await init();
  startSniper();

  while (true) {
    const control = await fetchControl();

    if (!control || control.status !== "RUNNING") {
      if (botRunning) console.log("⏸️ BOT PAUSED");
      botRunning = false;
    } else {
      botRunning = true;
      testMode = control.testMode ?? true;
    }

    if (botRunning) {
      await manage();
      console.log(
        testMode ? "🟡 TEST MODE" : "🟢 LIVE MODE",
        "| Positions:",
        positions.size
      );
    }

    await new Promise((r) => setTimeout(r, CONFIG.CONTROL_POLL_MS));
  }
}

run();
