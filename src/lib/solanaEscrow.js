/**
 * Solana Custody Wallet Escrow
 *
 * Flow:
 *  1. Hire:   Frontend sends USDC (buyer → escrow wallet), passes txSignature to backend.
 *             Backend calls verifyUsdcDeposit() to confirm on-chain before locking.
 *  2. Accept: Backend calls releaseToAgent() — sends 98% USDC to agent wallet.
 *             2% stays in escrow wallet as platform fee.
 *  3. Cancel/Refund: Backend calls refundToBuyer() — sends 100% USDC back to buyer.
 *
 * Required env vars:
 *   SOLANA_RPC_URL          - e.g. https://api.devnet.solana.com
 *   ESCROW_WALLET_PRIVATE_KEY - base58-encoded private key of custody wallet
 *   USDC_MINT_ADDRESS       - devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 *                             mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ── USDC has 6 decimal places ────────────────────────────────────────────────
const USDC_DECIMALS = 6;
export const PLATFORM_FEE_BPS = 200; // 2% = 200 basis points

function toRawAmount(usdcAmount) {
  return BigInt(Math.round(Number(usdcAmount) * 10 ** USDC_DECIMALS));
}

// ── Lazy-initialised singletons ───────────────────────────────────────────────

let _connection = null;
let _escrowKeypair = null;
let _usdcMint = null;

function getConnection() {
  if (!_connection) {
    const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');
    _connection = new Connection(rpcUrl, 'confirmed');
  }
  return _connection;
}

function getEscrowKeypair() {
  if (!_escrowKeypair) {
    const key = process.env.ESCROW_WALLET_PRIVATE_KEY;
    if (!key) throw new Error('ESCROW_WALLET_PRIVATE_KEY env var is required');
    _escrowKeypair = Keypair.fromSecretKey(bs58.decode(key));
  }
  return _escrowKeypair;
}

function getUsdcMint() {
  if (!_usdcMint) {
    const mint = process.env.USDC_MINT_ADDRESS;
    if (!mint) throw new Error('USDC_MINT_ADDRESS env var is required');
    _usdcMint = new PublicKey(mint);
  }
  return _usdcMint;
}

export function getEscrowWalletAddress() {
  return getEscrowKeypair().publicKey.toBase58();
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify a USDC deposit transaction submitted by the buyer.
 *
 * @param {string} txSignature    - Transaction signature from the buyer
 * @param {string} fromWallet     - Expected sender (buyer's wallet address)
 * @param {number} expectedAmount - Expected USDC amount (e.g. 100.00)
 * @returns {{ verified: boolean, actualAmount: number, error?: string }}
 */
export async function verifyUsdcDeposit(txSignature, fromWallet, expectedAmount) {
  try {
    const connection = getConnection();
    const mint = getUsdcMint();
    const escrowKeypair = getEscrowKeypair();

    const tx = await connection.getParsedTransaction(txSignature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, error: 'Transaction not found or not yet finalized' };
    }
    if (tx.meta?.err) {
      return { verified: false, error: 'Transaction failed on-chain' };
    }

    // Find the SPL token transfer instruction
    const instructions = tx.transaction.message.instructions;
    let depositAmount = null;

    for (const ix of instructions) {
      if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info;
        // Verify mint matches USDC
        if (info.mint && info.mint !== mint.toBase58()) continue;
        // Verify destination is escrow wallet's ATA (or escrow wallet itself)
        const dest = info.destination || info.newAuthority;
        if (!dest) continue;
        // Get escrow ATA address
        const escrowAta = await getAssociatedTokenAddress(mint, escrowKeypair.publicKey);
        if (dest !== escrowAta.toBase58()) continue;
        // Verify source authority is the buyer
        const authority = info.authority || info.source;
        if (authority !== fromWallet) continue;
        // Parse amount
        const rawAmount = BigInt(info.tokenAmount?.amount ?? info.amount ?? 0);
        depositAmount = Number(rawAmount) / 10 ** USDC_DECIMALS;
        break;
      }
    }

    if (depositAmount === null) {
      return { verified: false, error: 'No matching USDC transfer to escrow wallet found in transaction' };
    }

    // Allow up to 0.01 USDC tolerance for rounding
    if (depositAmount < expectedAmount - 0.01) {
      return {
        verified: false,
        actualAmount: depositAmount,
        error: `Deposit amount ${depositAmount} USDC is less than required ${expectedAmount} USDC`,
      };
    }

    return { verified: true, actualAmount: depositAmount };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

// ── Outbound transfers ────────────────────────────────────────────────────────

/**
 * Release 98% of escrowed USDC to the agent wallet.
 * Platform retains 2% in the escrow wallet.
 *
 * @param {string} agentWallet   - Agent's Solana wallet address
 * @param {number} escrowAmount  - Total USDC in escrow
 * @returns {{ txSignature: string, agentPayout: number, platformFee: number }}
 */
export async function releaseToAgent(agentWallet, escrowAmount) {
  const connection = getConnection();
  const escrowKeypair = getEscrowKeypair();
  const mint = getUsdcMint();

  const agentPayout = Math.floor(escrowAmount * (10000 - PLATFORM_FEE_BPS)) / 10000;
  const platformFee = escrowAmount - agentPayout;

  const agentPubkey = new PublicKey(agentWallet);

  // Get or create escrow ATA (source)
  const fromAta = await getOrCreateAssociatedTokenAccount(
    connection,
    escrowKeypair,
    mint,
    escrowKeypair.publicKey
  );

  // Get or create agent ATA (destination) — escrow wallet pays for account creation if needed
  const toAta = await getOrCreateAssociatedTokenAccount(
    connection,
    escrowKeypair,
    mint,
    agentPubkey
  );

  const txSignature = await transfer(
    connection,
    escrowKeypair,
    fromAta.address,
    toAta.address,
    escrowKeypair,
    toRawAmount(agentPayout)
  );

  return { txSignature, agentPayout, platformFee };
}

/**
 * Refund 100% of escrowed USDC to the buyer (cancelled/disputed refund).
 *
 * @param {string} buyerWallet   - Buyer's Solana wallet address
 * @param {number} escrowAmount  - Total USDC to refund
 * @returns {{ txSignature: string }}
 */
export async function refundToBuyer(buyerWallet, escrowAmount) {
  const connection = getConnection();
  const escrowKeypair = getEscrowKeypair();
  const mint = getUsdcMint();

  const buyerPubkey = new PublicKey(buyerWallet);

  const fromAta = await getOrCreateAssociatedTokenAccount(
    connection,
    escrowKeypair,
    mint,
    escrowKeypair.publicKey
  );

  const toAta = await getOrCreateAssociatedTokenAccount(
    connection,
    escrowKeypair,
    mint,
    buyerPubkey
  );

  const txSignature = await transfer(
    connection,
    escrowKeypair,
    fromAta.address,
    toAta.address,
    escrowKeypair,
    toRawAmount(escrowAmount)
  );

  return { txSignature };
}
