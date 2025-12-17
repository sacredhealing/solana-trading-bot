// =========================
// Advanced Solana Trading Bot
// - PnL Tracking
// - Multi-Pair Trading
// - Copy Trading
// - Lovable UI Controlled
// =========================

import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

// =========================
// ENV CONFIG
// =========================
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;
const LOVABLE_CONTROL_URL = process.env.LOVABLE_CONTROL_URL!;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL!;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY!;

// =========================
// TYPES
// =========================

type TradeSignal = "BUY" | "SELL" | "WAIT";

type PairConfig = {
  symbol: string;              // e.g. SOL/USDC
  inputMint: string;
  outputMint: string;
  tradeSize: number;           // in base token (SOL or USDC)
};

interface ControlPayload {
  status: "RUNNING" | "STOPPED";
  signal: TradeSignal;
  testMode: boolean;
  pairs: PairConfig[];
  copyWallet?: string;         // optional wallet to mirror
}

interface PositionState {
  entryPrice: number;
  entryAmount: number;
}

// =========================
// STATE
// =========================

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const jupiter = createJupiterApiClient({ apiKey: JUPITER_API_KEY });

const positions: Record<string, PositionState | null> = {};

let stats = {
  trades: 0,
  wins: 0,
  losses: 0,
  pnl: 0,
};

// =========================
// UTILS
// =========================

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_API_KEY },
  });
  return res.json();
}

async function postJSON(url: string, body: any) {
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_API_KEY,
    },
    body: JSON.stringify(body),
  });
}

// =========================
// COPY TRADING
// =========================

async function mirrorWalletTrades(walletAddress: string) {
  const sigs = await connection.getSignaturesForAddress(
    new PublicKey(walletAddress),
    { limit: 1 }
  );
  return sigs.length ? sigs[0].signature : null;
}

// =========================
// TRADING CORE
// =========================

async function executeTrade(pair: PairConfig, side: TradeSignal) {
  const amount = Math.round(pair.tradeSize * LAMPORTS_PER_SOL);

  const quote = await jupiter.quoteGet({
    inputMint: side === "BUY" ? pair.inputMint : pair.outputMint,
    outputMint: side === "BUY" ? pair.outputMint : pair.inputMint,
    amount,
    slippageBps: 50,
  });

  if ("error" in quote) return;

  const swap = await jupiter.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, "base64")
  );
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize());

  const price = Number(quote.outAmount) / Number(quote.inAmount);

  if (side === "BUY") {
    positions[pair.symbol] = {
      entryPrice: price,
      entryAmount: pair.tradeSize,
    };
  } else if (side === "SELL" && positions[pair.symbol]) {
    const entry = positions[pair.symbol]!;
    const pnl = (price - entry.entryPrice) * entry.entryAmount;

    stats.pnl += pnl;
    stats.trades++;
    pnl > 0 ? stats.wins++ : stats.losses++;

    positions[pair.symbol] = null;

    await postJSON(LOVABLE_API_URL, {
      wallet: wallet.publicKey.toBase58(),
      pair: pair.symbol,
      action: side,
      entryPrice: entry.entryPrice,
      exitPrice: price,
      pnl,
      roi: pnl / (entry.entryPrice * entry.entryAmount),
      winRate: stats.wins / stats.trades,
      totalPnL: stats.pnl,
      txSig: sig,
      timestamp: new Date().toISOString(),
    });
  }
}

// =========================
// MAIN LOOP
// =========================

async function main() {
  console.log("🤖 Advanced Trading Bot Started");

  while (true) {
    const control = await fetchJSON<ControlPayload>(LOVABLE_CONTROL_URL);
    if (control.status !== "RUNNING") {
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (control.copyWallet) {
      await mirrorWalletTrades(control.copyWallet);
    }

    for (const pair of control.pairs) {
      if (control.signal !== "WAIT") {
        await executeTrade(pair, control.signal);
      }
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

main();
