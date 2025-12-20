// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025 – PROFESSIONAL EDITION
// COPY-TRADING CORE FIX – STATE-BASED MIRRORING
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

import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

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
  VOLUME_DROP_EXIT: 0.5,

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
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";

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

/* =========================
   GLOBAL STATE
========================= */
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;
let creatorWallet: PublicKey | null = null;

const positions = new Map<string, Position>();

/* ========= CORE FIX STATE ========= */
const copyState = new Map<string, Map<string, number>>();
// wallet → mint → balance

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const timestamp = () => new Date().toLocaleTimeString();

/* =========================
   BALANCE
========================= */
async function solBalance(): Promise<number> {
  return (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
}

async function getTokenBalance(mint: PublicKey): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const acc = await getAccount(connection, ata);
    return Number(acc.amount);
  } catch {
    return 0;
  }
}

/* =========================
   BUY / SELL (UNCHANGED)
========================= */
// ⚠️ Your executeBuy()
// ⚠️ Your executeSell()
// ⚠️ Your risk logic
// ⚠️ Your sniper
// ⚠️ Your position manager
// ⚠️ Your Jupiter execution
//
// ❗ These remain EXACTLY AS YOU ALREADY HAVE THEM
//
// (Not repeated here to avoid duplication mistakes)
// Keep your existing implementations verbatim
//

/* =========================================================
   ✅ CORRECT COPY-TRADING LOGIC (CORE FIX)
========================================================= */

async function executeCopyTrading(wallets: string[], testMode: boolean) {
  for (const walletAddr of wallets) {
    try {
      const pubkey = new PublicKey(walletAddr);

      if (!copyState.has(walletAddr)) {
        copyState.set(walletAddr, new Map());
      }

      const previous = copyState.get(walletAddr)!;
      const current = new Map<string, number>();

      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: TOKEN_PROGRAM_ID }
      );

      for (const acc of tokenAccounts.value) {
        const info = acc.account.data.parsed.info;
        const mint = info.mint;
        const amount = Number(info.tokenAmount.uiAmount || 0);
        if (amount > 0) current.set(mint, amount);
      }

      /* ===== BUY DETECTION ===== */
      for (const [mint, amount] of current) {
        const prevAmount = previous.get(mint) || 0;

        if (amount > prevAmount && !positions.has(mint)) {
          console.log(
            `[${timestamp()}] 👥 COPY BUY ${mint.slice(0, 8)} from ${walletAddr.slice(0, 8)}`
          );
          await executeBuy(new PublicKey(mint), `COPY_${walletAddr.slice(0, 8)}`, testMode);
        }
      }

      /* ===== SELL DETECTION ===== */
      for (const [mint, prevAmount] of previous) {
        const nowAmount = current.get(mint) || 0;

        if (prevAmount > 0 && nowAmount === 0 && positions.has(mint)) {
          console.log(
            `[${timestamp()}] 👥 COPY SELL ${mint.slice(0, 8)} from ${walletAddr.slice(0, 8)}`
          );
          const pos = positions.get(mint)!;
          await executeSell(pos, "COPY_WALLET_EXIT", testMode);
        }
      }

      copyState.set(walletAddr, current);
      await sleep(CONFIG.RPC_DELAY_MS);

    } catch (e: any) {
      console.error(`[${timestamp()}] ⚠️ Copy error: ${e?.message}`);
    }
  }
}

/* =========================
   MAIN LOOP (UNCHANGED)
========================= */
// Your run() loop stays the same
// executeCopyTrading() is already called there
