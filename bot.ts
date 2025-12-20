// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025 – PROFESSIONAL EDITION
// Features: Pump.fun Sniping | Copy Trading | Trailing Stops | Volume Exit
// Risk: Max 30% Exposure | Rug Detection | Multi-Position Management
// Dashboard: Full Lovable UI Control | Test Mode | Real-time Logging
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

import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV CONFIGURATION
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL || "";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const LOVABLE_API_URL = process.env.LOVABLE_API_URL || "";
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL || "";
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || "";
const CREATOR_WALLET_STR = process.env.CREATOR_WALLET || "";

/* =========================
   CONFIG
========================= */
const CONFIG = {
  MAX_RISK_TOTAL: 0.30,
  MAX_POSITIONS: 10,
  INITIAL_STOP_LOSS: 0.12,
  TRAILING_STOP: 0.05,
  VOLUME_DROP_EXIT: 0.50,

  TRADE_SIZE_TINY: 0.01,
  TRADE_SIZE_SMALL: 0.02,
  TRADE_SIZE_MEDIUM: 0.03,
  TRADE_SIZE_LARGE: 0.05,

  MIN_LP_SOL: 5,
  MAX_TOP_HOLDER: 20,

  PROFIT_SHARE_PERCENT: 0.1111,

  RPC_DELAY_MS: 1200,
  MAIN_LOOP_MS: 3000,
  PAUSED_LOOP_MS: 10000,

  SLIPPAGE_BPS: 200,
};

/* =========================
   COPY TRADING CONFIG
========================= */
const COPY_CONFIG = {
  MIN_BALANCE_INCREASE_PCT: 0.10,
  DEBOUNCE_MS: 5000,
  OVERRIDE_STOPS_WHILE_HOLDING: true,
};

/* =========================
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/* =========================
   TYPES
========================= */
interface Position {
  mint: PublicKey;
  entryPrice: number;
  sizeSOL: number;
  tokenAmount: number;
  highPrice: number;
  stopPrice: number;
  peakVolume: number;
  source: string;
  entryTime: number;
}

interface ControlData {
  status: string;
  testMode: boolean;
  copyTrading?: { wallets?: string[] };
}

interface BotStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  startTime: number;
}

/* =========================
   GLOBAL STATE
========================= */
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;
let creatorWallet: PublicKey | null = null;

const positions = new Map<string, Position>();
let listenerActive = false;
let listenerSubscriptionId: number | null = null;
let currentTestMode = true;

const stats: BotStats = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  totalPnL: 0,
  startTime: Date.now(),
};

/* =========================
   COPY TRADING STATE
========================= */
const copyState = new Map<string, Map<string, number>>(); // wallet → mint → balance
const copyCooldown = new Map<string, number>(); // mint → last buy timestamp
const copyHoldOverride = new Set<string>(); // mints still held by copied wallets

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const timestamp = () => new Date().toLocaleTimeString();

async function solBalance(): Promise<number> {
  try {
    return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function getTokenBalance(mint: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const account = await getAccount(connection, ata);
    return Number(account.amount);
  } catch {
    return 0;
  }
}

/* =========================
   INITIALIZATION
========================= */
async function initialize(): Promise<boolean> {
  console.log("=".repeat(60));
  console.log(" 🚀 ULTIMATE MEME SNIPER BOT - Professional Edition");
  console.log("=".repeat(60));

  const missing: string[] = [];
  if (!RPC_URL) missing.push("SOLANA_RPC_URL");
  if (!PRIVATE_KEY) missing.push("SOLANA_PRIVATE_KEY");
  if (!JUPITER_API_KEY) missing.push("JUPITER_API_KEY");
  if (!LOVABLE_CONTROL_URL) missing.push("LOVABLE_CONTROL_URL");
  if (!SUPABASE_API_KEY) missing.push("SUPABASE_API_KEY");
  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach(v => console.error(` - ${v}`));
    return false;
  }

  try {
    connection = new Connection(RPC_URL, "confirmed");
    console.log("✅ RPC Connected");

    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log(`✅ Wallet: ${wallet.publicKey.toBase58()}`);

    jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY, basePath: "https://quote-api.jup.ag/v6" });
    console.log("✅ Jupiter API Connected");

    if (CREATOR_WALLET_STR) {
      try {
        creatorWallet = new PublicKey(CREATOR_WALLET_STR);
        console.log(`✅ Profit sharing enabled: ${creatorWallet.toBase58()}`);
      } catch {
        console.log("⚠️ Invalid CREATOR_WALLET - profit sharing disabled");
      }
    } else {
      console.log("ℹ️ Profit sharing disabled (no CREATOR_WALLET set)");
    }

    const balance = await solBalance();
    console.log(`✅ Balance: ${balance.toFixed(4)} SOL`);

    const healthCheck = await testJupiterHealth();
    if (!healthCheck) {
      console.error("❌ Jupiter API health check failed");
      return false;
    }
    console.log("✅ Jupiter API healthy");
    console.log("=".repeat(60));
    console.log(" ✅ Bot initialized successfully!");
    console.log("=".repeat(60));
    return true;
  } catch (error: any) {
    console.error("❌ Initialization failed:", error?.message);
    return false;
  }
}

async function testJupiterHealth(): Promise<boolean> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: 1000000,
      slippageBps: 50,
    });
    return !("error" in quote);
  } catch {
    return false;
  }
}

/* =========================
   DASHBOARD CONTROL
========================= */
async function fetchControl(): Promise<ControlData | null> {
  try {
    const res = await fetch(LOVABLE_CONTROL_URL, {
      headers: { "apikey": SUPABASE_API_KEY },
    });
    if (!res.ok) {
      console.error(`[${timestamp()}] ❌ Control fetch failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (error: any) {
    console.error(`[${timestamp()}] ❌ Control fetch error: ${error?.message}`);
    return null;
  }
}

async function postLovable(data: any) {
  if (!LOVABLE_API_URL) return;
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_API_KEY,
      },
      body: JSON.stringify({
        wallet: wallet.publicKey.toBase58(),
        timestamp: new Date().toISOString(),
        ...data,
      }),
    });
  } catch (error: any) {
    console.error(`[${timestamp()}] ⚠️ Lovable log failed: ${error?.message}`);
  }
}

/* =========================
   PRICE, VOLUME & TOKEN INFO
========================= */
async function getPrice(mint: PublicKey): Promise<number> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint: mint.toBase58(),
      outputMint: SOL_MINT,
      amount: 1_000_000,
      slippageBps: 50,
    });
    if ("error" in quote) return 0;
    return Number(quote.outAmount) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

async function getVolume24h(mint: PublicKey): Promise<number> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.pairs?.reduce((max: number, p: any) => Math.max(max, p.volume?.h24 || 0), 0) || 0;
  } catch {
    return 0;
  }
}

async function getTokenInfo(mint: PublicKey): Promise<{ price: number; volume: number; liquidity: number; topHolder: number }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`);
    if (!res.ok) return { price: 0, volume: 0, liquidity: 0, topHolder: 100 };
    const data = await res.json();
    const price = data.pairs?.[0]?.priceNative || 0;
    const volume = data.pairs?.reduce((max: number, p: any) => Math.max(max, p.volume?.h24 || 0), 0) || 0;
    const liquidity = data.pairs?.reduce((sum: number, p: any) => sum + (p.liquidity?.usd || 0), 0) || 0;
    const topHolder = data.pairs?.[0]?.topHolders?.[0]?.percent || 0;
    return { price, volume, liquidity, topHolder };
  } catch {
    return { price: 0, volume: 0, liquidity: 0, topHolder: 100 };
  }
}

/* =========================
   RUG CHECK
========================= */
async function isRug(mint: PublicKey): Promise<{ isRug: boolean; reason: string }> {
  try {
    const info = await getTokenInfo(mint);
    if (info.topHolder > CONFIG.MAX_TOP_HOLDER) {
      return { isRug: true, reason: `Top holder owns ${info.topHolder}%` };
    }
    const lpInSOL = info.liquidity / (info.price || 1);
    if (lpInSOL < CONFIG.MIN_LP_SOL) {
      return { isRug: true, reason: `Low liquidity: ${lpInSOL.toFixed(2)} SOL` };
    }
    return { isRug: false, reason: "" };
  } catch {
    return { isRug: true, reason: "Could not verify token" };
  }
}

/* =========================
   RISK MANAGEMENT
========================= */
function currentExposure(): number {
  return [...positions.values()].reduce((sum, pos) => sum + pos.sizeSOL, 0);
}

function calculateTradeSize(balance: number): number {
  const remainingRisk = balance * CONFIG.MAX_RISK_TOTAL - currentExposure();
  if (remainingRisk <= 0) return 0;

  let baseSize: number;
  if (balance < 100) baseSize = CONFIG.TRADE_SIZE_TINY;
  else if (balance < 200) baseSize = CONFIG.TRADE_SIZE_SMALL;
  else if (balance < 500) baseSize = CONFIG.TRADE_SIZE_MEDIUM;
  else baseSize = CONFIG.TRADE_SIZE_LARGE;

  return Math.min(baseSize, remainingRisk);
}

/* =========================
   SWAP EXECUTION
========================= */
// executeSwap() kept exactly as original, unchanged
// [Your full executeSwap() code goes here, same as original bot]
// For brevity, omitted in this snippet but must be copied exactly

/* =========================
   BUY / SELL LOGIC
========================= */
// executeBuy() and executeSell() kept exactly as original, unchanged
// For brevity, omitted in this snippet but must be copied exactly

/* =========================
   POSITION MANAGER
========================= */
async function managePositions(testMode: boolean) {
  for (const [mintStr, pos] of positions) {
    try {
      // 🚀 COPY WALLET HOLD OVERRIDE (NEW)
      if (COPY_CONFIG.OVERRIDE_STOPS_WHILE_HOLDING && copyHoldOverride.has(mintStr)) {
        continue;
      }

      const price = await getPrice(pos.mint);
      const volume = await getVolume24h(pos.mint);
      if (price <= 0) continue;

      if (volume < pos.peakVolume * CONFIG.VOLUME_DROP_EXIT && pos.peakVolume > 0) {
        console.log(`[${timestamp()}] 📉 Volume dropped: ${volume.toFixed(0)} < ${(pos.peakVolume * CONFIG.VOLUME_DROP_EXIT).toFixed(0)}`);
        await executeSell(pos, "VOLUME_DROP", testMode);
        continue;
      }

      if (price <= pos.stopPrice) {
        console.log(`[${timestamp()}] 🛑 Stop triggered: ${price.toFixed(8)} <= ${pos.stopPrice.toFixed(8)}`);
        await executeSell(pos, "TRAILING_STOP", testMode);
        continue;
      }

      if (price > pos.highPrice) {
        pos.highPrice = price;
        pos.stopPrice = price * (1 - CONFIG.TRAILING_STOP);
        pos.peakVolume = Math.max(pos.peakVolume, volume);
        console.log(`[${timestamp()}] 📈 New high: ${price.toFixed(8)} | Stop: ${pos.stopPrice.toFixed(8)}`);
      }

      await sleep(CONFIG.RPC_DELAY_MS);
    } catch (error: any) {
      console.error(`[${timestamp()}] ⚠️ Error managing ${mintStr.slice(0, 8)}...: ${error?.message}`);
    }
  }
}

/* =========================
   PUMP.FUN SNIPER
========================= */
// startPumpSniper() and stopPumpSniper() unchanged, same as original bot

/* =========================
   COPY TRADING (UPGRADED)
========================= */
async function executeCopyTrading(wallets: string[], testMode: boolean) {
  const now = Date.now();

  for (const walletAddr of wallets) {
    try {
      const pubkey = new PublicKey(walletAddr);

      if (!copyState.has(walletAddr)) {
        copyState.set(walletAddr, new Map());
      }

      const previous = copyState.get(walletAddr)!;
      const current = new Map<string, number>();

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });

      for (const acc of tokenAccounts.value) {
        const info = acc.account.data.parsed.info;
        const mint = info.mint;
        const amount = Number(info.tokenAmount.uiAmount || 0);
        if (amount > 0) current.set(mint, amount);
      }

      /* ===== BUY DETECTION ===== */
      for (const [mint, amount] of current) {
        const prevAmount = previous.get(mint) || 0;
        const pctIncrease = prevAmount > 0 ? (amount - prevAmount) / prevAmount : 1;

        const lastBuy = copyCooldown.get(mint) || 0;
        if (now - lastBuy < COPY_CONFIG.DEBOUNCE_MS) continue;

        if (amount > prevAmount && pctIncrease >= COPY_CONFIG.MIN_BALANCE_INCREASE_PCT && !positions.has(mint)) {
          console.log(`[${timestamp()}] 👥 COPY BUY ${mint.slice(0, 8)} (+${(pctIncrease * 100).toFixed(1)}%)`);

          copyCooldown.set(mint, now);
          copyHoldOverride.add(mint);

          await executeBuy(new PublicKey(mint), `COPY_${walletAddr.slice(0, 8)}`, testMode);
        }
      }

      /* ===== SELL DETECTION ===== */
      for (const [mint, prevAmount] of previous) {
        const nowAmount = current.get(mint) || 0;

        if (prevAmount > 0 && nowAmount === 0 && positions.has(mint)) {
          console.log(`[${timestamp()}] 👥 COPY SELL ${mint.slice(0, 8)} (wallet exit)`);

          copyHoldOverride.delete(mint);

          const pos = positions.get(mint)!;
          await executeSell(pos, "COPY_WALLET_EXIT", testMode);
        }
      }

      copyState.set(walletAddr, current);
      await sleep(CONFIG.RPC_DELAY_MS);

    } catch (error: any) {
      console.error(`[${timestamp()}] ⚠️ Copy trading error: ${error?.message}`);
    }
  }
}

/* =========================
   MAIN LOOP
========================= */
async function run() {
  const initialized = await initialize();
  if (!initialized) {
    console.error("❌ Bot failed to initialize. Exiting.");
    process.exit(1);
  }

  console.log(`[${timestamp()}] 🤖 Starting main loop...`);

  while (true) {
    try {
      const control = await fetchControl();
      const balance = await solBalance();

      if (!control || control.status !== "RUNNING") {
        stopPumpSniper();
        console.log(`[
