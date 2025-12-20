// =====================================================
// ULTIMATE SOLANA MEME SNIPER BOT 2025 – ELITE EDITION
// =====================================================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  Commitment,
} from "@solana/web3.js";

import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* =========================
   ENV
========================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;

/* =========================
   CONSTANTS
========================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const CONFIG = {
  MAX_RISK_TOTAL: 0.3,
  MAX_POSITIONS: 8,
  BASE_TRADE_SOL: 0.03,
  SLIPPAGE_BPS: 200,
  INITIAL_STOP: 0.15,
  TRAILING_STOP: 0.07,
  MIN_LP_SOL: 8,
  MAX_TOP_HOLDER: 18,
};

/* =========================
   STATE
========================= */
let connection: Connection;
let wallet: Keypair;
let jupiter: ReturnType<typeof createJupiterApiClient>;

const positions = new Map<string, any>();
const copyListeners = new Map<string, number>();

/* =========================
   UTILS
========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString();

/* =========================
   INIT
========================= */
async function init() {
  connection = new Connection(RPC_URL, {
    commitment: "processed" as Commitment,
  });

  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  jupiter = createJupiterApiClient({
    apiKey: JUPITER_API_KEY,
    basePath: "https://quote-api.jup.ag/v6",
  });

  console.log(`🚀 Wallet: ${wallet.publicKey.toBase58()}`);
}

/* =========================
   PRICE (FIXED)
========================= */
async function getSOLNormalizedPrice(mint: PublicKey): Promise<number> {
  try {
    const solIn = 0.1 * LAMPORTS_PER_SOL;

    const quote = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: mint.toBase58(),
      amount: solIn,
      slippageBps: 50,
    });

    if ("error" in quote) return 0;
    return solIn / Number(quote.outAmount);
  } catch {
    return 0;
  }
}

/* =========================
   RUG HEURISTICS
========================= */
async function advancedRugCheck(mint: PublicKey): Promise<boolean> {
  try {
    const mintAcc = await connection.getParsedAccountInfo(mint);
    const info: any = mintAcc.value?.data;
    if (!info) return true;

    if (info.parsed.info.mintAuthority !== null) return true;
    if (info.parsed.info.freezeAuthority !== null) return true;

    const dex = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`
    ).then(r => r.json());

    const pair = dex.pairs?.[0];
    if (!pair) return true;

    if (pair.liquidity.usd / pair.priceNative < CONFIG.MIN_LP_SOL) return true;
    if (pair.topHolders?.[0]?.percent > CONFIG.MAX_TOP_HOLDER) return true;

    return false;
  } catch {
    return true;
  }
}

/* =========================
   SWAP
========================= */
async function swap(
  inMint: string,
  outMint: string,
  lamports: number,
  testMode: boolean
) {
  if (testMode) {
    console.log(`[TEST] Swap ${lamports}`);
    return true;
  }

  const quote = await jupiter.quoteGet({
    inputMint: inMint,
    outputMint: outMint,
    amount: lamports,
    slippageBps: CONFIG.SLIPPAGE_BPS,
  });

  if ("error" in quote) return false;

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
  await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  return true;
}

/* =========================
   BUY
========================= */
async function buy(mint: PublicKey, source: string, testMode: boolean) {
  if (positions.has(mint.toBase58())) return;

  if (await advancedRugCheck(mint)) {
    console.log(`🚫 Rug blocked ${mint.toBase58().slice(0, 6)}`);
    return;
  }

  const ok = await swap(
    SOL_MINT,
    mint.toBase58(),
    CONFIG.BASE_TRADE_SOL * LAMPORTS_PER_SOL,
    testMode
  );

  if (!ok) return;

  const price = await getSOLNormalizedPrice(mint);

  positions.set(mint.toBase58(), {
    mint,
    entry: price,
    high: price,
    stop: price * (1 - CONFIG.INITIAL_STOP),
    source,
  });

  console.log(`🛒 BUY ${mint.toBase58().slice(0, 6)} @ ${price}`);
}

/* =========================
   POSITION MANAGER
========================= */
async function manage(testMode: boolean) {
  for (const [k, pos] of positions) {
    const price = await getSOLNormalizedPrice(pos.mint);
    if (!price) continue;

    if (price <= pos.stop) {
      console.log(`🛑 STOP ${k.slice(0, 6)}`);
      await swap(
        pos.mint.toBase58(),
        SOL_MINT,
        1_000_000,
        testMode
      );
      positions.delete(k);
      continue;
    }

    if (price > pos.high) {
      pos.high = price;
      pos.stop = price * (1 - CONFIG.TRAILING_STOP);
    }
  }
}

/* =========================
   SIGNATURE COPY TRADING
========================= */
function startCopyWallet(walletAddr: string, testMode: boolean) {
  const pubkey = new PublicKey(walletAddr);

  const sub = connection.onLogs(pubkey, async logs => {
    if (!logs.logs.some(l => l.includes("Swap"))) return;

    const tx = await connection.getParsedTransaction(logs.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) return;

    for (const ix of tx.transaction.message.instructions) {
      if ("parsed" in ix && ix.parsed?.info?.mint) {
        await buy(new PublicKey(ix.parsed.info.mint), "COPY_SIG", testMode);
      }
    }
  });

  copyListeners.set(walletAddr, sub);
}

/* =========================
   SUB-SECOND PUMP.FUN SNIPER
========================= */
function startPumpSniper(testMode: boolean) {
  connection.onLogs(
    PUMP_FUN_PROGRAM,
    async logs => {
      if (
        logs.logs.some(l => l.includes("InitializeMint")) &&
        logs.logs.some(l => l.includes("AddLiquidity"))
      ) {
        const tx = await connection.getParsedTransaction(logs.signature);
        const mint =
          tx?.meta?.postTokenBalances?.[0]?.mint;
        if (mint) {
          await buy(new PublicKey(mint), "PUMP_FAST", testMode);
        }
      }
    },
    "processed"
  );
}

/* =========================
   MAIN
========================= */
async function run() {
  await init();
  let testMode = true;

  startPumpSniper(testMode);
  startCopyWallet("PASTE_SMART_WALLET", testMode);

  while (true) {
    await manage(testMode);
    await sleep(2500);
  }
}

run();
