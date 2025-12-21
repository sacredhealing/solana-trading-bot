// =====================================================
// SOLANA MEME SNIPER – STABLE CORE (LIVE READY)
// Pump.fun | Signature Copy | Auto-Discovery | Lovable
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
import fetch from "node-fetch";

// ================= ENV =================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_LOG_URL = process.env.LOVABLE_LOG_URL!;

// ================= CONSTANTS =================
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const CONFIG = {
  BASE_SOL: 0.03,
  STOP_LOSS: 0.15,
  TRAILING_STOP: 0.07,
  MANAGE_INTERVAL: 2000,
};

// ================= STATE =================
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;
let running = false;

const positions = new Map<string, any>();
const knownSmartWallets = new Set<string>();
const discoveredWallets = new Map<string, number>(); // wallet -> wins

// ================= INIT =================
async function init() {
  const decoded = bs58.decode(PRIVATE_KEY);
  if (decoded.length !== 64) throw new Error("Invalid private key");

  wallet = Keypair.fromSecretKey(decoded);
  connection = new Connection(RPC_URL, { commitment: "processed" as Commitment });
  jupiter = createJupiterApiClient({
    apiKey: JUPITER_API_KEY,
    basePath: "https://quote-api.jup.ag/v6",
  });

  console.log("🚀 Wallet:", wallet.publicKey.toBase58());
}

// ================= LOVABLE =================
async function fetchControl() {
  const res = await fetch(LOVABLE_CONTROL_URL);
  return res.ok ? res.json() : null;
}

async function logLovable(data: any) {
  try {
    await fetch(LOVABLE_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch {}
}

// ================= PRICE =================
async function getPrice(mint: string): Promise<number> {
  try {
    const q = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: 0.1 * LAMPORTS_PER_SOL,
      slippageBps: 50,
    });
    if ("error" in q) return 0;
    return (0.1 * LAMPORTS_PER_SOL) / Number(q.outAmount);
  } catch {
    return 0;
  }
}

// ================= BUY =================
async function buy(mint: string, source: string, testMode: boolean) {
  if (positions.has(mint)) return;

  const price = await getPrice(mint);
  if (!price) return;

  if (!testMode) {
    const quote = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: CONFIG.BASE_SOL * LAMPORTS_PER_SOL,
      slippageBps: 200,
    });
    if (!("error" in quote)) {
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
      await connection.sendRawTransaction(tx.serialize());
    }
  }

  positions.set(mint, {
    mint,
    entry: price,
    high: price,
    stop: price * (1 - CONFIG.STOP_LOSS),
    source,
  });

  await logLovable({ type: "BUY", mint, source, testMode });
  console.log("🛒 BUY", mint.slice(0, 6), source);
}

// ================= MANAGER =================
async function manage(testMode: boolean) {
  for (const [mint, pos] of positions) {
    const price = await getPrice(mint);
    if (!price) continue;

    if (price <= pos.stop) {
      positions.delete(mint);
      await logLovable({ type: "SELL", mint, reason: "STOP" });
      console.log("🛑 EXIT", mint.slice(0, 6));
      continue;
    }

    if (price > pos.high) {
      pos.high = price;
      pos.stop = price * (1 - CONFIG.TRAILING_STOP);
    }
  }
}

// ================= PUMP.FUN =================
function startPumpSniper(testMode: boolean) {
  connection.onLogs(PUMP_FUN_PROGRAM, async l => {
    if (!running) return;
    if (!l.logs.some(x => x.includes("InitializeMint"))) return;

    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) await buy(mint, "PUMP", testMode);
  });
}

// ================= COPY (SIGNATURE BASED) =================
function startCopy(walletAddr: string, testMode: boolean) {
  const pub = new PublicKey(walletAddr);
  connection.onLogs(pub, async l => {
    if (!running) return;
    const tx = await connection.getParsedTransaction(l.signature);
    const mint = tx?.meta?.postTokenBalances?.[0]?.mint;
    if (mint) {
      await buy(mint, `COPY_${walletAddr.slice(0, 6)}`, testMode);
      discoveredWallets.set(walletAddr, (discoveredWallets.get(walletAddr) || 0) + 1);
    }
  });
}

// ================= MAIN =================
async function run() {
  await init();

  while (true) {
    const control = await fetchControl();
    if (!control || control.status !== "RUNNING") {
      running = false;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    running = true;
    const testMode = control.testMode ?? true;

    if (control.copyTrading?.wallets) {
      for (const w of control.copyTrading.wallets) {
        if (!knownSmartWallets.has(w)) {
          knownSmartWallets.add(w);
          startCopy(w, testMode);
        }
      }
    }

    startPumpSniper(testMode);
    await manage(testMode);
    await new Promise(r => setTimeout(r, CONFIG.MANAGE_INTERVAL));
  }
}

run();
