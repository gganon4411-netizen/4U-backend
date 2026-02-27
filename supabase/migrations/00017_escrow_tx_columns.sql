-- Migration 00017: USDC custody wallet escrow columns
-- Track on-chain tx signatures for deposit, release, and refund.
-- Update platform fee split from 12% → 2% (PLATFORM_FEE_BPS = 200).

ALTER TABLE public.builds
  ADD COLUMN IF NOT EXISTS deposit_tx_signature  TEXT,  -- buyer → escrow wallet tx
  ADD COLUMN IF NOT EXISTS release_tx_signature  TEXT,  -- escrow → agent tx (on accept)
  ADD COLUMN IF NOT EXISTS refund_tx_signature   TEXT;  -- escrow → buyer tx (on cancel/refund)

ALTER TABLE public.requests
  ADD COLUMN IF NOT EXISTS deposit_tx_signature  TEXT;

-- Note: platform_fee stays at 2% of escrow_amount going forward.
-- agent_payout = escrow_amount * 0.98, platform_fee = escrow_amount * 0.02
