import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

/* ================= ENV ================= */
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const CREATOR_WALLET = process.env.CREATOR_WALLET!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;

/* ================= CONFIG ================= */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SLIPPAGE_BPS = 300;
const AUTO_SELL_MINUTES = 10;
const TRAILING_STOP_PCT = 0.25;
const PROFIT_SHARE_PCT = 0.1111;
const MIN_BUY_SOL = 0.01;
const MAX_BUY_SOL = 0.1;

/* ================= SETUP ================= */
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const openPositions = new Map<
  string,
  { entry: number; peak: number; timeout: NodeJS.Timeout }
>();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ================= UTILS ================= */
async function fetchJSON(url: string) {
  const r = await fetch(url, { headers: { apikey: SUPABASE_API_KEY } });
  if (!r.ok) throw new Error("Fetch failed");
  return r.json();
}

async function postLovable(data: any) {
  try {
    await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_API_KEY,
      },
      body: JSON.stringify(data),
    });
  } catch {}
}

async function getBuySize(): Promise<number> {
  const bal = await connection.getBalance(wallet.publicKey);
  const sol = bal / LAMPORTS_PER_SOL;
  return Math.max(MIN_BUY_SOL, Math.min(MAX_BUY_SOL, sol * 0.05));
}

/* ================= SWAP ================= */
async function swap(
  inputMint: string,
  outputMint: string,
  solAmount: number
): Promise<string | null> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  if (lamports <= 0) return null;

  const quote = await jupiter.quoteGet({
    inputMint,
    outputMint,
    amount: lamports,
    slippageBps: SLIPPAGE_BPS,
  });

  if ((quote as any).error) return null;

  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote as any,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: "auto",
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);

  return connection.sendRawTransaction(tx.serialize());
}

/* ================= BUY ================= */
async function buy(mint: string, source: string) {
  if (openPositions.has(mint)) return;

  const size = await getBuySize();
  const sig = await swap(SOL_MINT, mint, size);
  if (!sig) return;

  console.log("✅ BUY TX:", sig);

  const timeout = setTimeout(
    () => sell(mint),
    AUTO_SELL_MINUTES * 60_000
  );

  openPositions.set(mint, {
    entry: size,
    peak: size,
    timeout,
  });

  await postLovable({ type: "BUY", mint, tx_signature: sig, source });
}

/* ================= SELL ================= */
async function sell(mint: string) {
  const pos = openPositions.get(mint);
  if (!pos) return;

  clearTimeout(pos.timeout);

  const sig = await swap(mint, SOL_MINT, pos.entry);
  if (!sig) return;

  console.log("💰 SELL TX:", sig);

  const profit = pos.peak - pos.entry;
  if (profit > 0) await profitShare(profit);

  openPositions.delete(mint);

  await postLovable({
    type: "SELL",
    mint,
    tx_signature: sig,
    verified: true,
  });
}

/* ================= TRAILING STOP ================= */
async function monitor() {
  for (const [mint, pos] of openPositions) {
    const quote = await jupiter.quoteGet({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: pos.entry * LAMPORTS_PER_SOL,
      slippageBps: 500,
    });

    const out = Number((quote as any)?.outAmount || 0) / LAMPORTS_PER_SOL;
    if (out > pos.peak) pos.peak = out;

    if (out < pos.peak * (1 - TRAILING_STOP_PCT)) {
      await sell(mint);
    }
  }
}

/* ================= PROFIT SHARE ================= */
async function profitShare(sol: number) {
  const lamports = Math.floor(sol * PROFIT_SHARE_PCT * LAMPORTS_PER_SOL);
  if (lamports <= 0) return;

  const ix = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(CREATOR_WALLET),
    lamports,
  });

  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  await connection.sendTransaction(tx);

  console.log("💸 PROFIT SHARE SENT");
}

/* ================= MAIN ================= */
async function run() {
  console.log("🤖 BOT LIVE");

  while (true) {
    try {
      const control = await fetchJSON(LOVABLE_CONTROL_URL);
      if (control.status !== "RUNNING") {
        await sleep(5000);
        continue;
      }

      for (const w of control.copyTrading?.wallets || []) {
        // Hook your mirror logic here if needed
      }

      await monitor();
    } catch (e) {
      console.error("Loop error");
    }

    await sleep(4000);
  }
}

run();
