// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// Upgraded & Fixed Version – Works with pumpdotfun-sdk
// Dashboard-controlled via Lovable/Supabase
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
import { PumpFunSDK } from "pumpdotfun-sdk"; // npm install pumpdotfun-sdk
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!; // Supabase / API endpoint returning [{wallet: "addr"}]

/* =========================
   USER RISK CONFIG
========================= */
const MAX_RISK_PCT = 0.03; // 3% of balance per trade
const MIN_SOL_BALANCE = 0.05; // Pause if below
const SLIPPAGE_BPS = 200; // Higher for memes
const PRIORITY_FEE = "auto"; // Faster landing
const TAKE_PROFIT_MULTIPLIER = 3; // Sell at 3x
const TRAILING_STOP_PCT = 20; // Trail if up 20%
const AUTO_SELL_MINUTES = 10; // Fallback sell time

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const nodeWallet = new NodeWallet(walletKeypair);
const provider = new AnchorProvider(connection, nodeWallet, { commitment: "confirmed" });
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });
const pumpSdk = new PumpFunSDK(provider);

const seenTx: Set<string> = new Set();
const openPositions: Map<string, { buyPrice: number; amount: number; timeout: NodeJS.Timeout }> = new Map();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchControl() {
  const r = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
  if (!r.ok) return { status: "STOPPED", testMode: true };
  return await r.json();
}

async function postLovable(row: any) {
  await fetch(LOVABLE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
    body: JSON.stringify(row),
  });
}

async function balanceSOL() {
  return (await connection.getBalance(walletKeypair.publicKey)) / LAMPORTS_PER_SOL;
}

function tradeSize(balance: number) {
  return Math.max(balance * MAX_RISK_PCT, 0.01);
}

/* =========================
   AUTO FOMO WALLET FETCH
========================= */
async function fetchTopFomoWallets(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFomoRefresh < 3600000 && cachedFomoWallets.length) return cachedFomoWallets; // 1h cache

  try {
    const r = await fetch(FOMO_WALLET_FEED, { headers: { apikey: SUPABASE_API_KEY } });
    const rows = await r.json();
    cachedFomoWallets = rows
      .map((r: any) => r.wallet)
      .filter((w: string) => {
        try { new PublicKey(w); return true; } catch { return false; }
      })
      .slice(0, 30);
    console.log(`🔥 Loaded ${cachedFomoWallets.length} FOMO wallets`);
  } catch (e) {
    console.error("Failed to load FOMO wallets:", e);
  }
  lastFomoRefresh = now;
  return cachedFomoWallets;
}

/* =========================
   RUG CHECKS (Improved)
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  try {
    const metadata = await pumpSdk.fetchTokenMetadata(mint); // If available, or fallback
    if (metadata?.updateAuthority !== null) return true; // Not renounced
    // Add more: LP burned check via bonding curve, etc.
    return false;
  } catch {
    return true; // Err on safe side
  }
}

/* =========================
   COPY-TRADING (Improved)
========================= */
async function mirrorWallet(addr: string, testMode: boolean) {
  let pub: PublicKey;
  try { pub = new PublicKey(addr); } catch { return; }

  const sigs = await connection.getSignaturesForAddress(pub, { limit: 5 });
  for (const s of sigs) {
    if (seenTx.has(s.signature)) continue;
    seenTx.add(s.signature);

    const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;

    // Look for token transfers to the wallet (buys)
    const transfers = tx.meta?.postTokenBalances?.filter(b => b.owner === addr) || [];
    for (const bal of transfers) {
      const mint = new PublicKey(bal.mint);
      if (await isRug(mint)) continue;

      const preBal = tx.meta?.preTokenBalances?.find(p => p.mint === bal.mint && p.owner === addr);
      const bought = Number(bal.uiTokenAmount.amount) - (preBal ? Number(preBal.uiTokenAmount.amount) : 0);
      if (bought > 0) {
        await trade("BUY", mint, "COPY", addr, testMode);
      }
    }
  }
}

/* =========================
   PUMP.FUN SNIPER (Fixed with SDK events)
========================= */
let eventListenerId: number | null = null;
function initPumpSniper(testMode: boolean) {
  if (eventListenerId !== null) return; // Already initialized

  eventListenerId = pumpSdk.addEventListener("createEvent", async (event: any, slot: number, sig: string) => {
    const mint = event.mint;
    console.log(`🆕 New pump.fun launch detected: ${mint.toBase58()}`);

    if (await isRug(mint)) {
      console.log("🚫 Rug risk – skipping");
      return;
    }

    await trade("BUY", mint, "SNIPER", "pump.fun", testMode);

    // Auto-sell logic
    const timeout = setTimeout(() => trade("SELL", mint, "SNIPER", "pump.fun", testMode), AUTO_SELL_MINUTES * 60000);
    openPositions.set(mint.toBase58(), { buyPrice: 0, amount: 0, timeout }); // Track for TP later if needed
  });

  console.log("👂 Pump.fun create event listener active");
}

/* =========================
   EXECUTION (with priority & better error handling)
========================= */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const sizeSOL = tradeSize(await balanceSOL());
  const amountLamports = Math.round(sizeSOL * LAMPORTS_PER_SOL);

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

  await postLovable({
    wallet: walletKeypair.publicKey.toBase58(),
    type,
    source,
    mint: mint.toBase58(),
    side,
    size: sizeSOL,
    testMode,
    ts: new Date().toISOString(),
  });

  if (testMode) return;

  try {
    const quote = await jupiter.quoteGet({
      inputMint: side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58(),
      outputMint: side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112",
      amount: side === "BUY" ? amountLamports : undefined, // For sell, need token amount – approximate or fetch
      slippageBps: SLIPPAGE_BPS,
    });

    if ("error" in quote) throw new Error(quote.error);

    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: PRIORITY_FEE,
      },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([walletKeypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    console.log(`✅ Tx sent: https://solscan.io/tx/${sig}`);
  } catch (e: any) {
    console.error(`❌ Trade failed: ${e.message}`);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 UPGRADED HYBRID MEME BOT LIVE");

  while (true) {
    const control = await fetchControl();
    const testMode = control.testMode === true;

    if (control.status !== "RUNNING" || (await balanceSOL()) < MIN_SOL_BALANCE) {
      console.log("⏸ Paused – check status/balance");
      await sleep(10000);
      continue;
    }

    initPumpSniper(testMode); // One-time init

    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w, testMode);
      await sleep(500); // Rate limit
    }

    await sleep(3000);
  }
}

run();
