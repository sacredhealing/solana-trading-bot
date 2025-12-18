import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;

if (!RPC_URL.startsWith("http")) {
  throw new Error("Invalid RPC URL");
}

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const TRADE_SOL = 0.02;
let listenerActive = false;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function trade(mint: string) {
  const amount = Math.floor(TRADE_SOL * LAMPORTS_PER_SOL);

  console.log("🚀 EXECUTING REAL BUY", { mint, amount });

  const quote = await jupiter.quoteGet({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: mint,
    amount,
    slippageBps: 300,
  });

  if ((quote as any).error) {
    console.error("❌ QUOTE FAILED");
    return;
  }

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

  const sig = await connection.sendRawTransaction(tx.serialize());
  console.log(`✅ TX SENT: https://solscan.io/tx/${sig}`);
}

function initPumpSniper() {
  if (listenerActive) return;

  connection.onLogs(
    PUMP_FUN_PROGRAM,
    async log => {
      if (log.err) return;

      console.log("👀 Pump.fun activity detected", log.signature);

      const tx = await connection.getParsedTransaction(log.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta?.postTokenBalances) return;

      for (const b of tx.meta.postTokenBalances) {
        const amt = Number(b.uiTokenAmount.uiAmount || 0);
        if (amt > 0) {
          const mint = b.mint;
          console.log("🆕 NEW MINT FOUND:", mint);
          await trade(mint);
          return;
        }
      }
    },
    "confirmed"
  );

  listenerActive = true;
  console.log("👂 Pump.fun sniper LIVE");
}

async function run() {
  console.log("🤖 BOT LIVE — WAITING FOR PUMP.FUN");
  initPumpSniper();

  while (true) {
    await sleep(10000);
  }
}

run();
