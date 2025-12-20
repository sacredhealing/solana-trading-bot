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
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV CONFIGURATION
   Required Railway Variables:
   - SOLANA_RPC_URL (Helius recommended)
   - SOLANA_PRIVATE_KEY (base58)
   - JUPITER_API_KEY (from jup.ag portal)
   - LOVABLE_API_URL (Supabase edge function)
   - LOVABLE_CONTROL_URL (Supabase edge function)
   - SUPABASE_API_KEY (anon key)
   - CREATOR_WALLET (optional - for profit sharing)
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL || "";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || "";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const LOVABLE_API_URL = process.env.LOVABLE_API_URL || "";
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL || "";
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY || "";
const CREATOR_WALLET_STR = process.env.CREATOR_WALLET || "";

/* =========================
   TRADING CONFIGURATION
========================= */
const CONFIG = {
  // Risk Management
  MAX_RISK_TOTAL: 0.30,        // 30% max portfolio exposure
  MAX_POSITIONS: 10,           // Max concurrent positions
  INITIAL_STOP_LOSS: 0.12,     // 12% initial stop loss
  TRAILING_STOP: 0.05,         // 5% trailing stop from highs
  VOLUME_DROP_EXIT: 0.50,      // Exit if volume drops 50% from peak
  
  // Position Sizing (based on balance)
  TRADE_SIZE_TINY: 0.01,       // Balance < 100 SOL
  TRADE_SIZE_SMALL: 0.02,      // Balance < 200 SOL
  TRADE_SIZE_MEDIUM: 0.03,     // Balance < 500 SOL
  TRADE_SIZE_LARGE: 0.05,      // Balance >= 500 SOL
  
  // Safety Filters
  MIN_LP_SOL: 5,               // Minimum liquidity in SOL
  MAX_TOP_HOLDER: 20,          // Max % a single holder can have
  
  // Profit Sharing (set to 0 to disable)
  PROFIT_SHARE_PERCENT: 0.1111, // 11.11% of profits
  
  // Timing
  RPC_DELAY_MS: 1200,          // Delay between RPC calls
  MAIN_LOOP_MS: 3000,          // Main loop interval
  PAUSED_LOOP_MS: 10000,       // Loop interval when paused
  
  // Slippage
  SLIPPAGE_BPS: 200,           // 2% slippage for meme coins
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
  tokenAmount: number;      // Actual token amount held
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
   INITIALIZATION
========================= */
async function initialize(): Promise<boolean> {
  console.log("=".repeat(60));
  console.log(" 🚀 ULTIMATE MEME SNIPER BOT - Professional Edition");
  console.log("=".repeat(60));
  
  // Validate required env vars
  const missing: string[] = [];
  if (!RPC_URL) missing.push("SOLANA_RPC_URL");
  if (!PRIVATE_KEY) missing.push("SOLANA_PRIVATE_KEY");
  if (!JUPITER_API_KEY) missing.push("JUPITER_API_KEY");
  if (!LOVABLE_CONTROL_URL) missing.push("LOVABLE_CONTROL_URL");
  if (!SUPABASE_API_KEY) missing.push("SUPABASE_API_KEY");
  
  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach(v => console.error(`   - ${v}`));
    return false;
  }
  
  try {
    // Initialize connection
    connection = new Connection(RPC_URL, "confirmed");
    console.log("✅ RPC Connected");
    
    // Initialize wallet
    wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log(`✅ Wallet: ${wallet.publicKey.toBase58()}`);
    
    // Initialize Jupiter
    jupiter = createJupiterApiClient({ 
      apiKey: JUPITER_API_KEY,
      basePath: "https://quote-api.jup.ag/v6"
    });
    console.log("✅ Jupiter API Connected");
    
    // Initialize creator wallet (optional)
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
    
    // Test connection
    const balance = await solBalance();
    console.log(`✅ Balance: ${balance.toFixed(4)} SOL`);
    
    // Test Jupiter
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
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      amount: 1000000,
      slippageBps: 50,
    });
    return !("error" in quote);
  } catch {
    return false;
  }
}

/* =========================
   UTILITY FUNCTIONS
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
   DASHBOARD CONTROL & LOGGING
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
   PRICE & VOLUME (DexScreener)
========================= */
async function getPrice(mint: PublicKey): Promise<number> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint: mint.toBase58(),
      outputMint: SOL_MINT,
      amount: 1_000_000, // 1 token (assuming 6 decimals)
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
async function executeSwap(
  side: "BUY" | "SELL",
  mint: PublicKey,
  amount: number
): Promise<{ success: boolean; sig?: string; outAmount?: number; error?: string }> {
  try {
    const inputMint = side === "BUY" ? SOL_MINT : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : SOL_MINT;
    
    console.log(`[${timestamp()}] 📡 Getting quote for ${side}...`);
    
    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount: Math.floor(amount),
      slippageBps: CONFIG.SLIPPAGE_BPS,
    });
    
    if ("error" in quote) {
      return { success: false, error: `Quote error: ${JSON.stringify(quote)}` };
    }
    
    console.log(`[${timestamp()}] 📡 Executing swap...`);
    
    const swapResponse = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote as any,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      },
    });
    
    const { swapTransaction } = swapResponse;
    if (!swapTransaction) {
      return { success: false, error: "No swap transaction returned" };
    }
    
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);
    
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    
    console.log(`[${timestamp()}] ⏳ Confirming: ${sig}`);
    
    // Wait for confirmation
    const latestBlockhash = await connection.getLatestBlockhash();
    try {
      await connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      }, "confirmed");
      console.log(`[${timestamp()}] ✅ Confirmed: https://solscan.io/tx/${sig}`);
    } catch (confirmError) {
      // Check if actually succeeded
      const status = await connection.getSignatureStatus(sig);
      if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
        console.log(`[${timestamp()}] ✅ Transaction succeeded (delayed confirmation)`);
      } else {
        console.log(`[${timestamp()}] ⚠️ Confirmation uncertain - check Solscan`);
      }
    }
    
    return { success: true, sig, outAmount: Number(quote.outAmount) };
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.error(`[${timestamp()}] ❌ Swap failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/* =========================
   BUY LOGIC
========================= */
async function executeBuy(mint: PublicKey, source: string, testMode: boolean): Promise<boolean> {
  const mintStr = mint.toBase58();
  
  // Check limits
  if (positions.size >= CONFIG.MAX_POSITIONS) {
    console.log(`[${timestamp()}] ⚠️ Max positions reached (${CONFIG.MAX_POSITIONS})`);
    return false;
  }
  
  if (positions.has(mintStr)) {
    console.log(`[${timestamp()}] ⚠️ Already holding ${mintStr.slice(0, 8)}...`);
    return false;
  }
  
  // Rug check
  const rugCheck = await isRug(mint);
  if (rugCheck.isRug) {
    console.log(`[${timestamp()}] 🚫 Rug detected: ${rugCheck.reason}`);
    return false;
  }
  
  // Calculate size
  const balance = await solBalance();
  const sizeSOL = calculateTradeSize(balance);
  if (sizeSOL <= 0) {
    console.log(`[${timestamp()}] ⚠️ No available risk capacity`);
    return false;
  }
  
  console.log(`[${timestamp()}] 🎯 ${testMode ? "TEST" : "LIVE"} BUY ${sizeSOL.toFixed(4)} SOL → ${mintStr.slice(0, 8)}... (${source})`);
  
  // TEST MODE: Simulate
  if (testMode) {
    const entryPrice = await getPrice(mint);
    const volume = await getVolume24h(mint);
    
    positions.set(mintStr, {
      mint,
      entryPrice,
      sizeSOL,
      tokenAmount: Math.floor((sizeSOL / entryPrice) * 1_000_000), // Simulated
      highPrice: entryPrice,
      stopPrice: entryPrice * (1 - CONFIG.INITIAL_STOP_LOSS),
      peakVolume: volume,
      source,
      entryTime: Date.now(),
    });
    
    stats.totalTrades++;
    
    await postLovable({
      action: "BUY",
      pair: mintStr,
      sizeSOL,
      entryPrice,
      txSignature: `TEST_${Date.now()}`,
      source,
      testMode: true,
      status: "CONFIRMED",
    });
    
    console.log(`[${timestamp()}] 🟡 TEST BUY recorded | Entry: ${entryPrice.toFixed(8)} SOL`);
    return true;
  }
  
  // LIVE MODE: Execute real swap
  const result = await executeSwap("BUY", mint, sizeSOL * LAMPORTS_PER_SOL);
  if (!result.success) {
    console.log(`[${timestamp()}] ❌ BUY failed: ${result.error}`);
    return false;
  }
  
  // Get actual token balance after swap
  await sleep(2000); // Wait for balance update
  const tokenAmount = await getTokenBalance(mint);
  const entryPrice = await getPrice(mint);
  const volume = await getVolume24h(mint);
  
  positions.set(mintStr, {
    mint,
    entryPrice,
    sizeSOL,
    tokenAmount,
    highPrice: entryPrice,
    stopPrice: entryPrice * (1 - CONFIG.INITIAL_STOP_LOSS),
    peakVolume: volume,
    source,
    entryTime: Date.now(),
  });
  
  stats.totalTrades++;
  
  await postLovable({
    action: "BUY",
    pair: mintStr,
    sizeSOL,
    entryPrice,
    tokenAmount,
    txSignature: result.sig,
    source,
    testMode: false,
    status: "CONFIRMED",
  });
  
  console.log(`[${timestamp()}] 🟢 LIVE BUY | ${sizeSOL.toFixed(4)} SOL | Entry: ${entryPrice.toFixed(8)} | Tokens: ${tokenAmount}`);
  return true;
}

/* =========================
   SELL LOGIC
========================= */
async function executeSell(pos: Position, reason: string, testMode: boolean): Promise<boolean> {
  const mintStr = pos.mint.toBase58();
  const currentPrice = await getPrice(pos.mint);
  
  const pricePnL = (currentPrice - pos.entryPrice) * pos.sizeSOL;
  const roi = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  
  console.log(`[${timestamp()}] 🔴 ${testMode ? "TEST" : "LIVE"} SELL ${mintStr.slice(0, 8)}... | PnL: ${pricePnL.toFixed(4)} SOL (${roi.toFixed(2)}%) | ${reason}`);
  
  // TEST MODE: Simulate
  if (testMode) {
    positions.delete(mintStr);
    
    if (pricePnL > 0) stats.wins++;
    else stats.losses++;
    stats.totalPnL += pricePnL;
    
    await postLovable({
      action: "SELL",
      pair: mintStr,
      sizeSOL: pos.sizeSOL,
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      pnl: pricePnL,
      roi,
      reason,
      txSignature: `TEST_${Date.now()}`,
      testMode: true,
      status: "CONFIRMED",
    });
    
    console.log(`[${timestamp()}] 🟡 TEST SELL recorded | PnL: ${pricePnL.toFixed(4)} SOL`);
    return true;
  }
  
  // LIVE MODE: Get actual token balance and sell
  const actualTokenAmount = await getTokenBalance(pos.mint);
  if (actualTokenAmount <= 0) {
    console.log(`[${timestamp()}] ⚠️ No tokens to sell`);
    positions.delete(mintStr);
    return false;
  }
  
  const result = await executeSwap("SELL", pos.mint, actualTokenAmount);
  if (!result.success) {
    console.log(`[${timestamp()}] ❌ SELL failed: ${result.error}`);
    return false;
  }
  
  const actualOutputSOL = (result.outAmount || 0) / LAMPORTS_PER_SOL;
  const actualPnL = actualOutputSOL - pos.sizeSOL;
  const actualRoi = pos.sizeSOL > 0 ? (actualPnL / pos.sizeSOL) * 100 : 0;
  
  positions.delete(mintStr);
  
  if (actualPnL > 0) stats.wins++;
  else stats.losses++;
  stats.totalPnL += actualPnL;
  
  // Profit sharing (only on profits)
  if (actualPnL > 0 && creatorWallet && CONFIG.PROFIT_SHARE_PERCENT > 0) {
    const feeSOL = actualPnL * CONFIG.PROFIT_SHARE_PERCENT;
    const feeLamports = Math.floor(feeSOL * LAMPORTS_PER_SOL);
    
    if (feeLamports > 5000) { // Min 5000 lamports
      try {
        const ix = SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: creatorWallet,
          lamports: feeLamports,
        });
        const msg = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
          instructions: [ix],
        }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        tx.sign([wallet]);
        await connection.sendTransaction(tx);
        console.log(`[${timestamp()}] 💰 Profit share: ${feeSOL.toFixed(4)} SOL`);
      } catch (e: any) {
        console.error(`[${timestamp()}] ⚠️ Profit share failed: ${e?.message}`);
      }
    }
  }
  
  await postLovable({
    action: "SELL",
    pair: mintStr,
    sizeSOL: pos.sizeSOL,
    entryPrice: pos.entryPrice,
    exitPrice: currentPrice,
    pnl: actualPnL,
    roi: actualRoi,
    reason,
    txSignature: result.sig,
    testMode: false,
    status: "CONFIRMED",
  });
  
  console.log(`[${timestamp()}] 🟢 LIVE SELL | Received: ${actualOutputSOL.toFixed(4)} SOL | PnL: ${actualPnL.toFixed(4)} SOL (${actualRoi.toFixed(2)}%)`);
  return true;
}

/* =========================
   POSITION MANAGER
========================= */
async function managePositions(testMode: boolean) {
  for (const [mintStr, pos] of positions) {
    try {
      const price = await getPrice(pos.mint);
      const volume = await getVolume24h(pos.mint);
      
      if (price <= 0) {
        console.log(`[${timestamp()}] ⚠️ Could not get price for ${mintStr.slice(0, 8)}...`);
        continue;
      }
      
      // Check volume drop exit
      if (volume < pos.peakVolume * CONFIG.VOLUME_DROP_EXIT && pos.peakVolume > 0) {
        console.log(`[${timestamp()}] 📉 Volume dropped: ${volume.toFixed(0)} < ${(pos.peakVolume * CONFIG.VOLUME_DROP_EXIT).toFixed(0)}`);
        await executeSell(pos, "VOLUME_DROP", testMode);
        continue;
      }
      
      // Check trailing stop
      if (price <= pos.stopPrice) {
        console.log(`[${timestamp()}] 🛑 Stop triggered: ${price.toFixed(8)} <= ${pos.stopPrice.toFixed(8)}`);
        await executeSell(pos, "TRAILING_STOP", testMode);
        continue;
      }
      
      // Update high price and trailing stop
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
function startPumpSniper(testMode: boolean) {
  if (listenerActive && currentTestMode === testMode) return;
  
  // Stop existing listener if mode changed
  if (listenerActive && listenerSubscriptionId !== null) {
    connection.removeOnLogsListener(listenerSubscriptionId);
    listenerActive = false;
    console.log(`[${timestamp()}] 🔄 Restarting sniper (mode changed)`);
  }
  
  currentTestMode = testMode;
  
  listenerSubscriptionId = connection.onLogs(
    PUMP_FUN_PROGRAM,
    async (log) => {
      if (log.err) return;
      if (!log.logs.some(l => l.includes("Create"))) return;
      
      try {
        const tx = await connection.getParsedTransaction(log.signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx?.meta?.postTokenBalances) return;
        
        for (const balance of tx.meta.postTokenBalances) {
          const amount = Number(balance.uiTokenAmount?.uiAmountString || 0);
          if (amount > 0 && balance.mint) {
            const mint = new PublicKey(balance.mint);
            console.log(`[${timestamp()}] 🆕 New pump.fun token: ${mint.toBase58().slice(0, 8)}...`);
            await executeBuy(mint, "PUMP_FUN", currentTestMode);
            break;
          }
        }
      } catch (error: any) {
        console.error(`[${timestamp()}] ⚠️ Sniper error: ${error?.message}`);
      }
    },
    "confirmed"
  );
  
  listenerActive = true;
  console.log(`[${timestamp()}] 🎯 Pump.fun sniper ACTIVE (${testMode ? "TEST" : "LIVE"} mode)`);
}

function stopPumpSniper() {
  if (listenerSubscriptionId !== null) {
    connection.removeOnLogsListener(listenerSubscriptionId);
    listenerSubscriptionId = null;
    listenerActive = false;
    console.log(`[${timestamp()}] 🛑 Pump.fun sniper STOPPED`);
  }
}

/* =========================
   COPY TRADING
========================= */
async function executeCopyTrading(wallets: string[], testMode: boolean) {
  for (const walletAddr of wallets) {
    try {
      const pubkey = new PublicKey(walletAddr);
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 5 });
      
      for (const sigInfo of sigs) {
        // Skip old transactions (> 5 minutes)
        if (sigInfo.blockTime && Date.now() / 1000 - sigInfo.blockTime > 300) continue;
        
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx?.meta?.postTokenBalances) continue;
        
        for (const balance of tx.meta.postTokenBalances) {
          if (balance.owner === walletAddr && Number(balance.uiTokenAmount?.uiAmountString || 0) > 0) {
            const mint = new PublicKey(balance.mint);
            console.log(`[${timestamp()}] 👥 Copy signal from ${walletAddr.slice(0, 8)}...`);
            await executeBuy(mint, `COPY_${walletAddr.slice(0, 8)}`, testMode);
          }
        }
      }
    } catch (error: any) {
      console.error(`[${timestamp()}] ⚠️ Copy trading error: ${error?.message}`);
    }
    
    await sleep(CONFIG.RPC_DELAY_MS);
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
      
      // Paused state
      if (!control || control.status !== "RUNNING") {
        stopPumpSniper();
        console.log(`[${timestamp()}] ⏸ PAUSED | Balance: ${balance.toFixed(4)} SOL | Positions: ${positions.size}`);
        await sleep(CONFIG.PAUSED_LOOP_MS);
        continue;
      }
      
      const testMode = control.testMode === true;
      
      // Stats display
      const winRate = stats.totalTrades > 0 ? ((stats.wins / stats.totalTrades) * 100).toFixed(1) : "0";
      console.log(`[${timestamp()}] 🔄 ${testMode ? "TEST" : "LIVE"} | Balance: ${balance.toFixed(4)} SOL | Positions: ${positions.size} | PnL: ${stats.totalPnL.toFixed(4)} | Win: ${winRate}%`);
      
      // Start/restart sniper if needed
      startPumpSniper(testMode);
      
      // Copy trading
      const copyWallets = control.copyTrading?.wallets || [];
      if (copyWallets.length > 0) {
        await executeCopyTrading(copyWallets, testMode);
      }
      
      // Manage positions
      await managePositions(testMode);
      
      await sleep(CONFIG.MAIN_LOOP_MS);
    } catch (error: any) {
      console.error(`[${timestamp()}] ❌ Main loop error: ${error?.message}`);
      await sleep(CONFIG.MAIN_LOOP_MS);
    }
  }
}

// Start the bot
run();
