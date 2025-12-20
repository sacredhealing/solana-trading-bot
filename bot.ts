// =====================================================
// ELITE TOP 1% SOLANA MEME SNIPER BOT 2025
// Features: Jito MEV Protection, Rugpull Detection, 
// Smart Filtering, Multi-RPC Failover, Dashboard Integration
// =====================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  Commitment,
  TransactionInstruction,
  SystemProgram,
  TransactionMessage,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import { createJupiterApiClient, QuoteResponse } from "@jup-ag/api";
import Database from "better-sqlite3";

// =====================================================
// TYPE DEFINITIONS
// =====================================================

interface DashboardControl {
  isRunning: boolean;
  testMode: boolean;
  tradingMode: "test" | "live" | "paper";
  tradeSizeSol: number;
  copyWallets: CopyWalletConfig[];
  signal: "BUY" | "WAIT" | "EXIT";
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
}

interface CopyWalletConfig {
  address: string;
  label: string;
  enabled: boolean;
  minCopySizeSol: number;
}

interface Position {
  mint: PublicKey;
  entryPrice: number;
  currentPrice: number;
  highPrice: number;
  stopLoss: number;
  sizeSol: number;
  source: string;
  copyWallet?: string;
  copyWalletLabel?: string;
  openedAt: number;
  txSignature?: string;
  partialExits: number;
}

interface TokenSafety {
  isSafe: boolean;
  reason?: string;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  lpLocked: boolean;
  holderCount: number;
  topHolderPct: number;
  creatorRugHistory: boolean;
  tokenAge: number;
}

interface TokenFilters {
  volume24h: number;
  liquidity: number;
  marketCap: number;
  holderCount: number;
  priceChange24h: number;
}

interface RPCEndpoint {
  url: string;
  connection: Connection;
  latency: number;
  failures: number;
  lastCheck: number;
  healthy: boolean;
}

interface TradeLog {
  action: "BUY" | "SELL" | "EXIT";
  mint: string;
  pair: string;
  source: string;
  copyWallet?: string;
  copyWalletLabel?: string;
  pnl?: number;
  roi?: number;
  entryPrice?: number;
  exitPrice?: number;
  sizeSol: number;
  txSignature?: string;
  walletAddress: string;
  testMode: boolean;
}

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================

const ENV = {
  // Primary RPC
  RPC_URL: process.env.SOLANA_RPC_URL || "",
  RPC_BACKUP_1: process.env.SOLANA_RPC_BACKUP_1 || "",
  RPC_BACKUP_2: process.env.SOLANA_RPC_BACKUP_2 || "",
  
  // Wallet
  PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || "",
  MULTI_WALLETS: process.env.MULTI_WALLETS?.split(",").filter(Boolean) || [],
  
  // APIs
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || "",
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || "",
  
  // Jito
  USE_JITO: process.env.USE_JITO === "true",
  JITO_TIP_LAMPORTS: parseInt(process.env.JITO_TIP_LAMPORTS || "10000"),
  JITO_AUTH_KEY: process.env.JITO_AUTH_KEY || "",
  
  // Dashboard
  LOVABLE_CONTROL_URL: process.env.LOVABLE_CONTROL_URL || "",
  LOVABLE_LOG_TRADE_URL: process.env.LOVABLE_LOG_TRADE_URL || "",
  SUPABASE_API_KEY: process.env.SUPABASE_API_KEY || "",
};

// =====================================================
// CONFIGURATION
// =====================================================

const CONFIG = {
  // Trade Sizing
  BASE_TRADE_SOL: 0.03,
  MAX_TRADE_SOL: 0.5,
  MIN_TRADE_SOL: 0.01,
  
  // Risk Management
  INITIAL_STOP_PCT: 0.15,
  TRAILING_STOP_PCT: 0.07,
  TAKE_PROFIT_1_PCT: 1.0,  // 100% gain - sell 50%
  TAKE_PROFIT_2_PCT: 2.0,  // 200% gain - sell 25%
  MAX_POSITION_AGE_MS: 4 * 60 * 60 * 1000, // 4 hours
  
  // Safety Filters
  MIN_VOLUME_24H: 10000,      // $10k minimum volume
  MIN_LIQUIDITY: 10000,       // $10k minimum liquidity
  MIN_HOLDER_COUNT: 50,       // Minimum holders
  MAX_TOP_HOLDER_PCT: 50,     // Max % held by top holder
  MIN_TOKEN_AGE_SECONDS: 60,  // Minimum 1 minute old
  
  // Execution
  SLIPPAGE_BPS: 200,
  PRIORITY_FEE_LAMPORTS: 50000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 500,
  
  // Expectancy
  MIN_EXPECTANCY: -0.02,
  MIN_TRADES_FOR_EXPECTANCY: 6,
  
  // Polling
  CONTROL_POLL_INTERVAL_MS: 5000,
  POSITION_CHECK_INTERVAL_MS: 2000,
  RPC_HEALTH_CHECK_INTERVAL_MS: 30000,
};

// =====================================================
// CONSTANTS
// =====================================================

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf",
  "https://amsterdam.mainnet.block-engine.jito.wtf",
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
];

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVpXBpqNY1bVx9F3KddVj",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

// =====================================================
// STATE
// =====================================================

let primaryConnection: Connection;
let jupiter: ReturnType<typeof createJupiterApiClient>;
const rpcEndpoints: RPCEndpoint[] = [];
const wallets: Keypair[] = [];
const positions = new Map<string, Position>();
const presignedCache = new Map<string, VersionedTransaction>();
const copyWalletSubscriptions = new Map<string, number>();
const ruggedCreators = new Set<string>();

let dashboardControl: DashboardControl = {
  isRunning: false,
  testMode: true,
  tradingMode: "test",
  tradeSizeSol: CONFIG.BASE_TRADE_SOL,
  copyWallets: [],
  signal: "WAIT",
  stopLossPct: CONFIG.INITIAL_STOP_PCT,
  takeProfitPct: CONFIG.TAKE_PROFIT_1_PCT,
  trailingStopPct: CONFIG.TRAILING_STOP_PCT,
};

// =====================================================
// DATABASE
// =====================================================

const db = new Database("elite_trades.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS stats (
    source TEXT PRIMARY KEY,
    trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    pnl REAL DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS rugged_creators (
    address TEXT PRIMARY KEY,
    rugged_at INTEGER,
    token_mint TEXT
  );
  
  CREATE TABLE IF NOT EXISTS trade_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT,
    action TEXT,
    source TEXT,
    entry_price REAL,
    exit_price REAL,
    pnl REAL,
    created_at INTEGER
  );
`);

// Load rugged creators from DB
const loadRuggedCreators = () => {
  const rows = db.prepare("SELECT address FROM rugged_creators").all() as { address: string }[];
  rows.forEach(r => ruggedCreators.add(r.address));
  console.log(`📋 Loaded ${ruggedCreators.size} known rugged creators`);
};

// =====================================================
// UTILITIES
// =====================================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const log = (emoji: string, message: string, data?: any) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`, data ? JSON.stringify(data) : "");
};

const shortenAddress = (addr: string, chars = 6): string => {
  return `${addr.slice(0, chars)}...${addr.slice(-4)}`;
};

// =====================================================
// MULTI-RPC MANAGEMENT
// =====================================================

async function initRPCEndpoints() {
  const urls = [ENV.RPC_URL, ENV.RPC_BACKUP_1, ENV.RPC_BACKUP_2].filter(Boolean);
  
  for (const url of urls) {
    const connection = new Connection(url, { commitment: "processed" as Commitment });
    rpcEndpoints.push({
      url,
      connection,
      latency: 0,
      failures: 0,
      lastCheck: 0,
      healthy: true,
    });
  }
  
  await checkRPCHealth();
  primaryConnection = getBestRPC().connection;
  log("🌐", `Initialized ${rpcEndpoints.length} RPC endpoints`);
}

async function checkRPCHealth() {
  for (const endpoint of rpcEndpoints) {
    const start = Date.now();
    try {
      await endpoint.connection.getLatestBlockhash();
      endpoint.latency = Date.now() - start;
      endpoint.healthy = true;
      endpoint.failures = 0;
    } catch (e) {
      endpoint.failures++;
      endpoint.healthy = endpoint.failures < 3;
      endpoint.latency = 99999;
    }
    endpoint.lastCheck = Date.now();
  }
  
  // Sort by latency
  rpcEndpoints.sort((a, b) => a.latency - b.latency);
}

function getBestRPC(): RPCEndpoint {
  const healthy = rpcEndpoints.filter(e => e.healthy);
  if (healthy.length === 0) {
    log("⚠️", "All RPCs unhealthy, using primary");
    return rpcEndpoints[0];
  }
  return healthy[0];
}

async function executeWithFailover<T>(
  fn: (connection: Connection) => Promise<T>,
  retries = CONFIG.MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let i = 0; i < retries; i++) {
    const rpc = getBestRPC();
    try {
      return await fn(rpc.connection);
    } catch (e) {
      lastError = e as Error;
      rpc.failures++;
      log("⚠️", `RPC ${shortenAddress(rpc.url)} failed, retrying...`, { attempt: i + 1 });
      await sleep(CONFIG.RETRY_DELAY_MS * (i + 1));
    }
  }
  
  throw lastError || new Error("All retries failed");
}

// =====================================================
// JITO BUNDLE SUBMISSION
// =====================================================

function getRandomJitoTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

async function createJitoTipInstruction(payer: PublicKey): Promise<TransactionInstruction> {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: getRandomJitoTipAccount(),
    lamports: ENV.JITO_TIP_LAMPORTS,
  });
}

async function sendJitoBundle(
  transactions: VersionedTransaction[],
  wallet: Keypair
): Promise<string | null> {
  const endpoint = JITO_ENDPOINTS[Math.floor(Math.random() * JITO_ENDPOINTS.length)];
  
  try {
    const serializedTxs = transactions.map(tx => 
      Buffer.from(tx.serialize()).toString("base64")
    );
    
    const response = await fetch(`${endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ENV.JITO_AUTH_KEY && { "Authorization": `Bearer ${ENV.JITO_AUTH_KEY}` }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTxs],
      }),
    });
    
    const result = await response.json();
    
    if (result.error) {
      log("❌", "Jito bundle error", result.error);
      return null;
    }
    
    log("✅", `Jito bundle submitted: ${result.result}`);
    return result.result;
  } catch (e) {
    log("❌", "Jito submission failed", { error: (e as Error).message });
    return null;
  }
}

// =====================================================
// TOKEN SAFETY CHECKS (RUGPULL DETECTION)
// =====================================================

async function checkTokenSafety(mint: PublicKey): Promise<TokenSafety> {
  const result: TokenSafety = {
    isSafe: false,
    mintAuthority: false,
    freezeAuthority: false,
    lpLocked: true,
    holderCount: 0,
    topHolderPct: 0,
    creatorRugHistory: false,
    tokenAge: 0,
  };
  
  try {
    // Check mint authorities
    const mintInfo = await getMint(primaryConnection, mint);
    result.mintAuthority = mintInfo.mintAuthority !== null;
    result.freezeAuthority = mintInfo.freezeAuthority !== null;
    
    // If mint or freeze authority exists, it's not safe
    if (result.mintAuthority) {
      result.reason = "Mint authority active - can mint unlimited tokens";
      return result;
    }
    
    if (result.freezeAuthority) {
      result.reason = "Freeze authority active - can freeze your tokens";
      return result;
    }
    
    // Check token age (using slot time approximation)
    const signatures = await primaryConnection.getSignaturesForAddress(mint, { limit: 1 });
    if (signatures.length > 0 && signatures[0].blockTime) {
      result.tokenAge = Date.now() / 1000 - signatures[0].blockTime;
      if (result.tokenAge < CONFIG.MIN_TOKEN_AGE_SECONDS) {
        result.reason = `Token too new (${result.tokenAge.toFixed(0)}s old)`;
        return result;
      }
    }
    
    // Check creator history using Birdeye API if available
    if (ENV.BIRDEYE_API_KEY) {
      const tokenData = await fetchBirdeyeTokenData(mint.toBase58());
      if (tokenData) {
        result.holderCount = tokenData.holderCount || 0;
        result.topHolderPct = tokenData.topHolderPct || 0;
        
        if (result.holderCount < CONFIG.MIN_HOLDER_COUNT) {
          result.reason = `Too few holders (${result.holderCount})`;
          return result;
        }
        
        if (result.topHolderPct > CONFIG.MAX_TOP_HOLDER_PCT) {
          result.reason = `Top holder owns ${result.topHolderPct}% of supply`;
          return result;
        }
        
        // Check if creator has rugged before
        if (tokenData.creator && ruggedCreators.has(tokenData.creator)) {
          result.creatorRugHistory = true;
          result.reason = `Creator ${shortenAddress(tokenData.creator)} has rugged before`;
          return result;
        }
      }
    }
    
    result.isSafe = true;
    return result;
  } catch (e) {
    log("⚠️", `Safety check failed for ${shortenAddress(mint.toBase58())}`, { error: (e as Error).message });
    result.reason = "Safety check failed";
    return result;
  }
}

// =====================================================
// SMART FILTERING (BIRDEYE/DEXSCREENER)
// =====================================================

interface BirdeyeTokenData {
  volume24h: number;
  liquidity: number;
  marketCap: number;
  holderCount: number;
  priceChange24h: number;
  topHolderPct: number;
  creator?: string;
}

async function fetchBirdeyeTokenData(mint: string): Promise<BirdeyeTokenData | null> {
  if (!ENV.BIRDEYE_API_KEY) return null;
  
  try {
    const response = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${mint}`,
      {
        headers: {
          "X-API-KEY": ENV.BIRDEYE_API_KEY,
          "x-chain": "solana",
        },
      }
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const token = data.data;
    
    return {
      volume24h: token.v24hUSD || 0,
      liquidity: token.liquidity || 0,
      marketCap: token.mc || 0,
      holderCount: token.holder || 0,
      priceChange24h: token.priceChange24hPercent || 0,
      topHolderPct: token.top10HolderPercent || 0,
      creator: token.creator,
    };
  } catch (e) {
    return null;
  }
}

async function passesFilters(mint: string): Promise<{ passed: boolean; reason?: string }> {
  const data = await fetchBirdeyeTokenData(mint);
  
  if (!data) {
    // If no Birdeye data, proceed with caution but don't block
    log("⚠️", `No filter data for ${shortenAddress(mint)}, proceeding with caution`);
    return { passed: true };
  }
  
  if (data.volume24h < CONFIG.MIN_VOLUME_24H) {
    return { passed: false, reason: `Low volume: $${data.volume24h.toFixed(0)}` };
  }
  
  if (data.liquidity < CONFIG.MIN_LIQUIDITY) {
    return { passed: false, reason: `Low liquidity: $${data.liquidity.toFixed(0)}` };
  }
  
  if (data.holderCount < CONFIG.MIN_HOLDER_COUNT) {
    return { passed: false, reason: `Too few holders: ${data.holderCount}` };
  }
  
  return { passed: true };
}

// =====================================================
// JUPITER INTEGRATION
// =====================================================

async function initJupiter() {
  jupiter = createJupiterApiClient({
    apiKey: ENV.JUPITER_API_KEY || undefined,
    basePath: "https://quote-api.jup.ag/v6",
  });
  log("🪐", "Jupiter API initialized");
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps = CONFIG.SLIPPAGE_BPS
): Promise<QuoteResponse | null> {
  try {
    const quote = await jupiter.quoteGet({
      inputMint,
      outputMint,
      amount,
      slippageBps,
    });
    
    if ("error" in quote) {
      return null;
    }
    
    return quote;
  } catch (e) {
    return null;
  }
}

async function getPrice(mint: PublicKey): Promise<number> {
  const solIn = 0.1 * LAMPORTS_PER_SOL;
  const quote = await getQuote(SOL_MINT, mint.toBase58(), solIn);
  
  if (!quote) return 0;
  return solIn / Number(quote.outAmount);
}

async function buildSwapTransaction(
  quote: QuoteResponse,
  wallet: Keypair,
  addJitoTip = false
): Promise<VersionedTransaction | null> {
  try {
    const { swapTransaction } = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
      },
    });
    
    let tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    
    // Add Jito tip if enabled
    if (addJitoTip && ENV.USE_JITO) {
      // For now, we'll submit separately with Jito
      // In production, you'd modify the transaction to include the tip
    }
    
    tx.sign([wallet]);
    return tx;
  } catch (e) {
    log("❌", "Failed to build swap transaction", { error: (e as Error).message });
    return null;
  }
}

// =====================================================
// DASHBOARD INTEGRATION
// =====================================================

async function fetchDashboardControl(): Promise<void> {
  if (!ENV.LOVABLE_CONTROL_URL) return;
  
  try {
    const response = await fetch(ENV.LOVABLE_CONTROL_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "apikey": ENV.SUPABASE_API_KEY,
        "Authorization": `Bearer ${ENV.SUPABASE_API_KEY}`,
      },
    });
    
    if (!response.ok) {
      log("⚠️", `Dashboard control fetch failed: ${response.status}`);
      return;
    }
    
    const data = await response.json();
    
    dashboardControl = {
      isRunning: data.status === "RUNNING",
      testMode: data.testMode ?? true,
      tradingMode: data.tradingMode || "test",
      tradeSizeSol: data.tradeSizeSol || CONFIG.BASE_TRADE_SOL,
      copyWallets: (data.copyWallets || []).map((cw: any) => ({
        address: cw.address || cw.wallet_address,
        label: cw.label || shortenAddress(cw.address || cw.wallet_address),
        enabled: cw.enabled !== false,
        minCopySizeSol: cw.minCopySizeSol || 0.01,
      })),
      signal: data.signal || "WAIT",
      stopLossPct: data.stopLossPct || CONFIG.INITIAL_STOP_PCT,
      takeProfitPct: data.takeProfitPct || CONFIG.TAKE_PROFIT_1_PCT,
      trailingStopPct: data.trailingStopPct || CONFIG.TRAILING_STOP_PCT,
    };
    
    log("📡", "Dashboard control updated", {
      running: dashboardControl.isRunning,
      testMode: dashboardControl.testMode,
      copyWallets: dashboardControl.copyWallets.length,
    });
  } catch (e) {
    log("❌", "Failed to fetch dashboard control", { error: (e as Error).message });
  }
}

async function logTrade(trade: TradeLog): Promise<void> {
  if (!ENV.LOVABLE_LOG_TRADE_URL) return;
  
  try {
    const response = await fetch(ENV.LOVABLE_LOG_TRADE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": ENV.SUPABASE_API_KEY,
        "Authorization": `Bearer ${ENV.SUPABASE_API_KEY}`,
      },
      body: JSON.stringify({
        action: trade.action,
        mint: trade.mint,
        pair: trade.pair || `${shortenAddress(trade.mint)}`,
        source: trade.source,
        copy_wallet: trade.copyWallet,
        copy_wallet_label: trade.copyWalletLabel,
        pnl: trade.pnl || 0,
        roi: trade.roi || 0,
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        size_sol: trade.sizeSol,
        tx_signature: trade.txSignature,
        wallet_address: trade.walletAddress,
        test_mode: trade.testMode,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log("⚠️", `Trade log failed: ${response.status}`, { error: errorText });
    } else {
      log("📊", `Trade logged: ${trade.action} ${shortenAddress(trade.mint)}`);
    }
  } catch (e) {
    log("❌", "Failed to log trade", { error: (e as Error).message });
  }
}

// =====================================================
// COPY WALLET MANAGEMENT
// =====================================================

function syncCopyWalletSubscriptions() {
  const currentWallets = new Set(dashboardControl.copyWallets.filter(w => w.enabled).map(w => w.address));
  
  // Remove subscriptions for wallets no longer in list
  for (const [address, subscriptionId] of copyWalletSubscriptions) {
    if (!currentWallets.has(address)) {
      primaryConnection.removeOnLogsListener(subscriptionId);
      copyWalletSubscriptions.delete(address);
      log("📤", `Unsubscribed from wallet: ${shortenAddress(address)}`);
    }
  }
  
  // Add subscriptions for new wallets
  for (const wallet of dashboardControl.copyWallets) {
    if (wallet.enabled && !copyWalletSubscriptions.has(wallet.address)) {
      startCopyWallet(wallet.address, wallet.label);
    }
  }
}

function startCopyWallet(address: string, label: string) {
  if (copyWalletSubscriptions.has(address)) return;
  
  try {
    const pubkey = new PublicKey(address);
    
    const subscriptionId = primaryConnection.onLogs(pubkey, async (logs) => {
      if (!dashboardControl.isRunning) return;
      
      // Look for swap signatures
      const isSwap = logs.logs.some(
        log => log.includes("Swap") || log.includes("swap") || log.includes("Route")
      );
      
      if (!isSwap) return;
      
      // Get transaction details
      try {
        const tx = await primaryConnection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx?.meta?.postTokenBalances) return;
        
        // Find the token being bought
        const tokenBalance = tx.meta.postTokenBalances.find(
          b => b.mint !== SOL_MINT && b.owner === address
        );
        
        if (tokenBalance?.mint) {
          log("👀", `Copy signal from ${label}: ${shortenAddress(tokenBalance.mint)}`);
          
          await buy(
            new PublicKey(tokenBalance.mint),
            "COPY_TRADE",
            address,
            label
          );
        }
      } catch (e) {
        // Transaction parsing can fail, that's okay
      }
    });
    
    copyWalletSubscriptions.set(address, subscriptionId);
    log("📥", `Subscribed to copy wallet: ${label} (${shortenAddress(address)})`);
  } catch (e) {
    log("❌", `Failed to subscribe to ${shortenAddress(address)}`, { error: (e as Error).message });
  }
}

// =====================================================
// PUMP.FUN SNIPER
// =====================================================

function startPumpFunSniper() {
  log("🎯", "Starting Pump.fun sniper...");
  
  primaryConnection.onLogs(PUMP_FUN_PROGRAM, async (logs) => {
    if (!dashboardControl.isRunning) return;
    
    // Look for new token initialization
    const isNewToken = logs.logs.some(
      log => log.includes("InitializeMint") || log.includes("Create")
    );
    
    if (!isNewToken) return;
    
    try {
      const tx = await primaryConnection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
      });
      
      if (!tx?.meta?.postTokenBalances) return;
      
      const tokenBalance = tx.meta.postTokenBalances.find(
        b => b.mint !== SOL_MINT
      );
      
      if (tokenBalance?.mint) {
        log("🆕", `New Pump.fun token: ${shortenAddress(tokenBalance.mint)}`);
        
        await buy(
          new PublicKey(tokenBalance.mint),
          "PUMP_FUN"
        );
      }
    } catch (e) {
      // Parsing can fail, continue
    }
  });
}

// =====================================================
// EXPECTANCY TRACKING
// =====================================================

function recordTradeStats(source: string, pnl: number) {
  const row = db.prepare("SELECT * FROM stats WHERE source = ?").get(source) as any;
  
  if (!row) {
    db.prepare("INSERT INTO stats (source, trades, wins, losses, pnl) VALUES (?, 1, ?, ?, ?)").run(
      source,
      pnl > 0 ? 1 : 0,
      pnl <= 0 ? 1 : 0,
      pnl
    );
  } else {
    db.prepare(`
      UPDATE stats SET 
        trades = trades + 1,
        wins = wins + ?,
        losses = losses + ?,
        pnl = pnl + ?
      WHERE source = ?
    `).run(pnl > 0 ? 1 : 0, pnl <= 0 ? 1 : 0, pnl, source);
  }
}

function getExpectancy(source: string): number {
  const row = db.prepare("SELECT * FROM stats WHERE source = ?").get(source) as any;
  
  if (!row || row.trades < CONFIG.MIN_TRADES_FOR_EXPECTANCY) {
    return 1; // Default multiplier for new sources
  }
  
  const winRate = row.wins / row.trades;
  const avgWin = row.pnl > 0 ? row.pnl / row.wins : 0;
  
  return winRate * avgWin;
}

function isSourceDisabled(source: string): boolean {
  const expectancy = getExpectancy(source);
  return expectancy < CONFIG.MIN_EXPECTANCY;
}

// =====================================================
// TRADING FUNCTIONS
// =====================================================

async function buy(
  mint: PublicKey,
  source: string,
  copyWallet?: string,
  copyWalletLabel?: string
): Promise<void> {
  const mintStr = mint.toBase58();
  
  // Skip if already in position
  if (positions.has(mintStr)) {
    log("⏭️", `Already in position: ${shortenAddress(mintStr)}`);
    return;
  }
  
  // Skip if source is disabled due to bad expectancy
  if (isSourceDisabled(source)) {
    log("🚫", `Source disabled due to low expectancy: ${source}`);
    return;
  }
  
  // Safety checks
  const safety = await checkTokenSafety(mint);
  if (!safety.isSafe) {
    log("⚠️", `Token failed safety: ${safety.reason}`);
    return;
  }
  
  // Smart filters
  const filters = await passesFilters(mintStr);
  if (!filters.passed) {
    log("📉", `Token failed filters: ${filters.reason}`);
    return;
  }
  
  // Calculate trade size
  const expectancyMult = Math.min(1.5, Math.max(0.5, getExpectancy(source)));
  const tradeSizeSol = Math.min(
    CONFIG.MAX_TRADE_SOL,
    Math.max(CONFIG.MIN_TRADE_SOL, dashboardControl.tradeSizeSol * expectancyMult)
  );
  
  // Get current price
  const price = await getPrice(mint);
  if (!price) {
    log("❌", `Could not get price for ${shortenAddress(mintStr)}`);
    return;
  }
  
  // Execute trade
  const testMode = dashboardControl.testMode;
  let txSignature: string | undefined;
  
  if (!testMode) {
    const quote = await getQuote(
      SOL_MINT,
      mintStr,
      Math.floor(tradeSizeSol * LAMPORTS_PER_SOL)
    );
    
    if (!quote) {
      log("❌", `Failed to get quote for ${shortenAddress(mintStr)}`);
      return;
    }
    
    const wallet = wallets[0];
    const tx = await buildSwapTransaction(quote, wallet, ENV.USE_JITO);
    
    if (!tx) {
      log("❌", `Failed to build transaction for ${shortenAddress(mintStr)}`);
      return;
    }
    
    // Submit via Jito or regular RPC
    if (ENV.USE_JITO) {
      const bundleId = await sendJitoBundle([tx], wallet);
      if (bundleId) {
        txSignature = bundleId;
      }
    }
    
    if (!txSignature) {
      // Fallback to regular submission
      txSignature = await executeWithFailover(async (conn) => {
        return await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
      });
    }
  } else {
    // Test mode - generate fake signature
    txSignature = `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  
  // Create position
  const position: Position = {
    mint,
    entryPrice: price,
    currentPrice: price,
    highPrice: price,
    stopLoss: price * (1 - dashboardControl.stopLossPct),
    sizeSol: tradeSizeSol,
    source,
    copyWallet,
    copyWalletLabel,
    openedAt: Date.now(),
    txSignature,
    partialExits: 0,
  };
  
  positions.set(mintStr, position);
  
  // Log to dashboard
  await logTrade({
    action: "BUY",
    mint: mintStr,
    pair: shortenAddress(mintStr),
    source,
    copyWallet,
    copyWalletLabel,
    sizeSol: tradeSizeSol,
    entryPrice: price,
    txSignature,
    walletAddress: wallets[0].publicKey.toBase58(),
    testMode,
  });
  
  log("🛒", `BUY ${shortenAddress(mintStr)} via ${source}`, {
    price,
    sizeSol: tradeSizeSol,
    testMode,
    copyWalletLabel,
  });
}

async function sell(
  position: Position,
  percentage: number,
  reason: string
): Promise<void> {
  const mintStr = position.mint.toBase58();
  const sellSize = position.sizeSol * (percentage / 100);
  
  const testMode = dashboardControl.testMode;
  let txSignature: string | undefined;
  
  if (!testMode) {
    const quote = await getQuote(
      mintStr,
      SOL_MINT,
      Math.floor(sellSize * LAMPORTS_PER_SOL / position.currentPrice)
    );
    
    if (quote) {
      const wallet = wallets[0];
      const tx = await buildSwapTransaction(quote, wallet, ENV.USE_JITO);
      
      if (tx) {
        if (ENV.USE_JITO) {
          txSignature = await sendJitoBundle([tx], wallet) || undefined;
        }
        
        if (!txSignature) {
          txSignature = await executeWithFailover(async (conn) => {
            return await conn.sendRawTransaction(tx.serialize(), {
              skipPreflight: true,
              maxRetries: 3,
            });
          });
        }
      }
    }
  } else {
    txSignature = `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  
  // Calculate PnL
  const pnlSol = (position.currentPrice - position.entryPrice) / position.entryPrice * sellSize;
  const roi = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
  // Record stats
  recordTradeStats(position.source, pnlSol);
  
  // Log to dashboard
  await logTrade({
    action: percentage === 100 ? "EXIT" : "SELL",
    mint: mintStr,
    pair: shortenAddress(mintStr),
    source: position.source,
    copyWallet: position.copyWallet,
    copyWalletLabel: position.copyWalletLabel,
    pnl: pnlSol,
    roi,
    entryPrice: position.entryPrice,
    exitPrice: position.currentPrice,
    sizeSol: sellSize,
    txSignature,
    walletAddress: wallets[0].publicKey.toBase58(),
    testMode,
  });
  
  log(pnlSol >= 0 ? "💰" : "📉", `${reason} ${shortenAddress(mintStr)}`, {
    pnl: pnlSol.toFixed(4),
    roi: `${roi.toFixed(2)}%`,
    percentage: `${percentage}%`,
  });
  
  // Update or remove position
  if (percentage === 100) {
    positions.delete(mintStr);
  } else {
    position.sizeSol -= sellSize;
    position.partialExits++;
  }
}

// =====================================================
// POSITION MANAGEMENT
// =====================================================

async function managePositions(): Promise<void> {
  for (const [mintStr, position] of positions) {
    try {
      // Get current price
      const currentPrice = await getPrice(position.mint);
      if (!currentPrice) continue;
      
      position.currentPrice = currentPrice;
      
      // Check for stop loss
      if (currentPrice <= position.stopLoss) {
        await sell(position, 100, "🛑 Stop Loss");
        continue;
      }
      
      // Check for max age
      if (Date.now() - position.openedAt > CONFIG.MAX_POSITION_AGE_MS) {
        await sell(position, 100, "⏰ Max Age Exit");
        continue;
      }
      
      // Update trailing stop
      if (currentPrice > position.highPrice) {
        position.highPrice = currentPrice;
        const newStop = currentPrice * (1 - dashboardControl.trailingStopPct);
        if (newStop > position.stopLoss) {
          position.stopLoss = newStop;
          log("📈", `Trailing stop updated for ${shortenAddress(mintStr)}`, {
            newStop: newStop.toFixed(8),
          });
        }
      }
      
      // Check for take profit levels
      const gain = (currentPrice - position.entryPrice) / position.entryPrice;
      
      if (gain >= CONFIG.TAKE_PROFIT_2_PCT && position.partialExits < 2) {
        await sell(position, 25, "🎯 Take Profit 2");
      } else if (gain >= CONFIG.TAKE_PROFIT_1_PCT && position.partialExits < 1) {
        await sell(position, 50, "🎯 Take Profit 1");
      }
    } catch (e) {
      log("⚠️", `Position management error for ${mintStr}`, { error: (e as Error).message });
    }
  }
}

// =====================================================
// CONTROL LOOP
// =====================================================

async function controlLoop(): Promise<void> {
  while (true) {
    try {
      await fetchDashboardControl();
      syncCopyWalletSubscriptions();
    } catch (e) {
      log("❌", "Control loop error", { error: (e as Error).message });
    }
    
    await sleep(CONFIG.CONTROL_POLL_INTERVAL_MS);
  }
}

// =====================================================
// MAIN
// =====================================================

async function main() {
  log("🚀", "ELITE TOP 1% SOLANA MEME SNIPER BOT STARTING...");
  
  // Validate environment
  if (!ENV.PRIVATE_KEY) {
    throw new Error("SOLANA_PRIVATE_KEY is required");
  }
  
  if (!ENV.RPC_URL) {
    throw new Error("SOLANA_RPC_URL is required");
  }
  
  // Initialize
  try {
    // Load wallets
    wallets.push(Keypair.fromSecretKey(bs58.decode(ENV.PRIVATE_KEY)));
    for (const key of ENV.MULTI_WALLETS) {
      wallets.push(Keypair.fromSecretKey(bs58.decode(key)));
    }
    log("👛", `Loaded ${wallets.length} wallet(s)`);
    
    // Initialize RPC
    await initRPCEndpoints();
    
    // Initialize Jupiter
    await initJupiter();
    
    // Load known rugged creators
    loadRuggedCreators();
    
    // Fetch initial dashboard control
    await fetchDashboardControl();
    
    // Start control loop
    controlLoop();
    
    // Start Pump.fun sniper
    startPumpFunSniper();
    
    // Start RPC health check loop
    setInterval(checkRPCHealth, CONFIG.RPC_HEALTH_CHECK_INTERVAL_MS);
    
    log("✅", "Bot initialized successfully!");
    log("📊", "Dashboard integration active", {
      controlUrl: ENV.LOVABLE_CONTROL_URL ? "configured" : "not configured",
      logUrl: ENV.LOVABLE_LOG_TRADE_URL ? "configured" : "not configured",
    });
    
    // Main position management loop
    while (true) {
      if (dashboardControl.isRunning) {
        await managePositions();
      }
      
      await sleep(CONFIG.POSITION_CHECK_INTERVAL_MS);
    }
  } catch (e) {
    log("💥", "Fatal error", { error: (e as Error).message });
    process.exit(1);
  }
}

// Run
main().catch(console.error);
