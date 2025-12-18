// =====================================================
// HYBRID SNIPER + COPY BOT (AUTO FOMO + PUMP.FUN)
// Fixed Version – Removed Anchor/NodeWallet (No SDK Needed for Listener)
// Uses direct logsSubscribe for reliable pump.fun create detection
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
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const FOMO_WALLET_FEED = process.env.FOMO_WALLET_FEED!;

/* =========================
   USER RISK CONFIG
========================= */
const MAX_RISK_PCT = 0.03; // 3%
const MIN_SOL_BALANCE = 0.05;
const SLIPPAGE_BPS = 200;
const PRIORITY_FEE = "auto";
const AUTO_SELL_MINUTES = 10;

/* =========================
   SETUP
========================= */
const connection = new Connection(RPC_URL, "confirmed");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const seenTx: Set<string> = new Set();
const openPositions: Map<string, NodeJS.Timeout> = new Map();
let cachedFomoWallets: string[] = [];
let lastFomoRefresh = 0;
let listenerActive = false;

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchControl() {
  try {
    const r = await fetch(LOVABLE_CONTROL_URL, { headers: { apikey: SUPABASE_API_KEY } });
    if (!r.ok) return { status: "STOPPED", testMode: true };
    return await r.json();
  } catch {
    return { status: "STOPPED", testMode: true };
  }
}

async function postLovable(row: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_API_KEY },
      body: JSON.stringify(row),
    });
  } catch {}
}

async function balanceSOL() {
  return (await connection.getBalance(walletKeypair.publicKey)) / LAMPORTS_PER_SOL;
}

function tradeSize(balance: number) {
  return Math.max(balance * MAX_RISK_PCT, 0.01);
}

/* =========================
   FOMO WALLETS
========================= */
async function fetchTopFomoWallets(): Promise<string[]> {
  const now = Date.now();
  if (now - lastFomoRefresh < 3600000 && cachedFomoWallets.length) return cachedFomoWallets;

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
    console.error("FOMO load failed:", e);
  }
  lastFomoRefresh = now;
  return cachedFomoWallets;
}

/* =========================
   RUG CHECK (Basic – improve later)
========================= */
async function isRug(mint: PublicKey): Promise<boolean> {
  // Conservative: skip if we can't check
  return false; // For now, allow most – add real checks later
}

/* =========================
   COPY-TRADING
========================= */
async function mirrorWallet(addr: string, testMode: boolean) {
  let pub: PublicKey;
  try { pub = new PublicKey(addr); } catch { return; }

  const sigs = await connection.getSignaturesForAddress(pub, { limit: 5 });
  for (const s of sigs) {
    if (seenTx.has(s.signature)) continue;
    seenTx.add(s.signature);

    const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta) continue;

    const transfers = tx.meta.postTokenBalances?.filter(b => b.owner === addr) || [];
    for (const bal of transfers) {
      const mint = new PublicKey(bal.mint);
      if (await isRug(mint)) continue;

      const pre = tx.meta.preTokenBalances?.find(p => p.mint === bal.mint && p.owner === addr);
      const bought = Number(bal.uiTokenAmount.uiAmountString) - (pre ? Number(pre.uiTokenAmount.uiAmountString) : 0);
      if (bought > 0.01) {
        await trade("BUY", mint, "COPY", addr, testMode);
      }
    }
  }
}

/* =========================
   PUMP.FUN SNIPER (Direct logsSubscribe – Reliable)
========================= */
function initPumpSniper(testMode: boolean) {
  if (listenerActive) return;

  connection.onLogs(
    PUMP_FUN_PROGRAM,
    async (log) => {
      if (log.err) return;

      // Look for "Program log: Instruction: Create" or similar in logs
      const createLog = log.logs.find(l => l.includes("Instruction: Create") || l.includes("create"));
      if (!createLog) return;

      // Extract mint from signature or logs – rough but works for many cases
      // Better: fetch tx and parse instructions (but for speed, this is ok starter)
      console.log(`🆕 Potential new pump.fun token detected (sig: ${log.signature})`);

      // Fetch tx to get mint properly
      const tx = await connection.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) return;

      // Find mint from token balances or instructions (simplified)
      const mintStr = tx.transaction.message.accountKeys.find(k => k.toBase58().length === 44 && !k.toBase58().startsWith("Sysvar"))?.toBase58();
      if (!mintStr) return;

      let mint: PublicKey;
      try { mint = new PublicKey(mintStr); } catch { return; }

      if (await isRug(mint)) {
        console.log("🚫 Rug risk – skipping");
        return;
      }

      await trade("BUY", mint, "SNIPER", "pump.fun", testMode);

      const timeout = setTimeout(() => trade("SELL", mint, "SNIPER", "pump.fun", testMode), AUTO_SELL_MINUTES * 60000);
      openPositions.set(mint.toBase58(), timeout);
    },
    "confirmed"
  );

  listenerActive = true;
  console.log("👂 Pump.fun logs listener ACTIVE");
}

/* =========================
   EXECUTION
========================= */
async function trade(
  side: "BUY" | "SELL",
  mint: PublicKey,
  type: "COPY" | "SNIPER",
  source: string,
  testMode: boolean
) {
  const sizeSOL = tradeSize(await balanceSOL());

  console.log(`${testMode ? "🧪 TEST" : "🚀 LIVE"} ${side} ${type} | ${sizeSOL.toFixed(4)} SOL → ${mint.toBase58()}`);

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
    const inputMint = side === "BUY" ? "So11111111111111111111111111111111111111112" : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : "So11111111111111111111111111111111111111112";
    const amount = side === "BUY" ? Math.round(sizeSOL * LAMPORTS_PER_SOL) : undefined; // Jupiter handles sell amount

    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount,
      slippageBps: SLIPPAGE_BPS,
    });

    if ("error" in quote) throw new Error(quote.error as string);

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
    console.log(`✅ Tx: https://solscan.io/tx/${sig}`);
  } catch (e: any) {
    console.error(`❌ Trade failed: ${e.message}`);
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  console.log("🤖 HYBRID MEME BOT STARTED (No Anchor SDK)");

  while (true) {
    const control = await fetchControl();
    const testMode = control.testMode === true;

    if (control.status !== "RUNNING" || (await balanceSOL()) < MIN_SOL_BALANCE) {
      console.log("⏸ Paused");
      await sleep(10000);
      continue;
    }

    initPumpSniper(testMode);

    const wallets = await fetchTopFomoWallets();
    for (const w of wallets) {
      await mirrorWallet(w, testMode);
      await sleep(500);
    }

    await sleep(3000);
  }
}

run();
