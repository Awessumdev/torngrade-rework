CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'BET_STAKE', 'BET_WIN', 'BET_VOID_REFUND', 'WITHDRAWAL_REQUEST', 'WITHDRAWAL_REFUND', 'WITHDRAWAL_PAID', 'ADMIN_ADJUSTMENT');
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'LIVE', 'FINISHED', 'CANCELLED');
CREATE TYPE "MarketStatus" AS ENUM ('DRAFT', 'OPEN', 'SUSPENDED', 'CLOSED', 'SETTLING', 'SETTLED', 'VOID');
CREATE TYPE "OutcomeStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "BetStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'VOID');
CREATE TYPE "SettlementStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'PENDING', 'PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED');
CREATE TYPE "WithdrawalPayoutMethod" AS ENUM ('MANUAL');
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "WhitelistStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');
CREATE TYPE "ReconciliationStatus" AS ENUM ('CLEAN', 'MISMATCH', 'FAILED');
CREATE TYPE "GlobalBettingStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "externalTornId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WhitelistEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "status" "WhitelistStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "addedByAdminId" UUID NOT NULL,
    "removedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WhitelistEntry_removed_consistency" CHECK (
        ("status" = 'ACTIVE' AND "removedAt" IS NULL)
        OR ("status" = 'REMOVED' AND "removedAt" IS NOT NULL)
    )
);

CREATE TABLE "Wallet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "currency" VARCHAR(16) NOT NULL DEFAULT 'XAN',
    "availableBalance" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "pendingWithdrawal" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Wallet_availableBalance_nonnegative" CHECK ("availableBalance" >= 0),
    CONSTRAINT "Wallet_pendingWithdrawal_nonnegative" CHECK ("pendingWithdrawal" >= 0)
);

CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "balanceBefore" DECIMAL(36,18) NOT NULL,
    "balanceAfter" DECIMAL(36,18) NOT NULL,
    "referenceType" VARCHAR(64) NOT NULL,
    "referenceId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "LedgerEntry_balance_math" CHECK (
        ("direction" = 'CREDIT' AND "balanceAfter" = "balanceBefore" + "amount")
        OR ("direction" = 'DEBIT' AND "balanceAfter" = "balanceBefore" - "amount")
        OR ("type" = 'WITHDRAWAL_PAID' AND "direction" = 'DEBIT' AND "balanceAfter" = "balanceBefore")
    ),
    CONSTRAINT "LedgerEntry_balanceAfter_nonnegative" CHECK ("balanceAfter" >= 0)
);

CREATE TABLE "Event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Market" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eventId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "description" TEXT,
    "resolutionRules" TEXT NOT NULL,
    "resolutionSource" TEXT NOT NULL,
    "voidConditions" TEXT,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'DRAFT',
    "winningOutcomeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "Market_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Market_closes_after_opens" CHECK ("closesAt" > "opensAt")
);

CREATE TABLE "Outcome" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "marketId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "odds" DECIMAL(18,8) NOT NULL,
    "status" "OutcomeStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Outcome_odds_minimum" CHECK ("odds" >= 1)
);

CREATE TABLE "Bet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "outcomeId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "stake" DECIMAL(36,18) NOT NULL,
    "oddsSnapshot" DECIMAL(18,8) NOT NULL,
    "potentialPayout" DECIMAL(36,18) NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'OPEN',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Bet_stake_positive" CHECK ("stake" > 0),
    CONSTRAINT "Bet_oddsSnapshot_minimum" CHECK ("oddsSnapshot" >= 1),
    CONSTRAINT "Bet_potentialPayout_minimum" CHECK ("potentialPayout" >= "stake")
);

CREATE TABLE "Settlement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "marketId" UUID NOT NULL,
    "winningOutcomeId" UUID,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PROCESSING',
    "startedByAdminId" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Deposit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "externalDepositId" TEXT NOT NULL,
    "providerEventId" TEXT,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "creditedLedgerEntryId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Deposit_amount_positive" CHECK ("amount" > 0)
);

CREATE TABLE "Withdrawal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "externalWithdrawalId" TEXT,
    "providerPayoutId" TEXT,
    "paidLedgerEntryId" UUID,
    "refundLedgerEntryId" UUID,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "payoutMethod" "WithdrawalPayoutMethod" NOT NULL DEFAULT 'MANUAL',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Withdrawal_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "Withdrawal_paid_requires_paidAt" CHECK ("status" <> 'PAID' OR "paidAt" IS NOT NULL),
    CONSTRAINT "Withdrawal_paid_requires_providerPayoutId" CHECK ("status" <> 'PAID' OR "providerPayoutId" IS NOT NULL),
    CONSTRAINT "Withdrawal_paid_requires_paidLedgerEntryId" CHECK ("status" <> 'PAID' OR "paidLedgerEntryId" IS NOT NULL),
    CONSTRAINT "Withdrawal_rejected_requires_rejectedAt" CHECK ("status" <> 'REJECTED' OR "rejectedAt" IS NOT NULL),
    CONSTRAINT "Withdrawal_rejected_requires_refundLedgerEntryId" CHECK ("status" <> 'REJECTED' OR "refundLedgerEntryId" IS NOT NULL)
);

CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "roles" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" UUID,
    "actorAdminId" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" UUID,
    "requestId" VARCHAR(128),
    "idempotencyKey" VARCHAR(128),
    "ipAddress" INET,
    "userAgent" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "ReconciliationStatus" NOT NULL,
    "walletCount" INTEGER NOT NULL,
    "mismatchCount" INTEGER NOT NULL,
    "totalLedgerEntries" INTEGER NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    CONSTRAINT "ReconciliationSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReconciliationSnapshot_counts_nonnegative" CHECK ("walletCount" >= 0 AND "mismatchCount" >= 0 AND "totalLedgerEntries" >= 0)
);

CREATE TABLE "SystemConfig" (
    "key" VARCHAR(64) NOT NULL DEFAULT 'production',
    "globalBettingStatus" "GlobalBettingStatus" NOT NULL DEFAULT 'ACTIVE',
    "betLimits" JSONB NOT NULL,
    "updatedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "SystemConfig_key_production" CHECK ("key" = 'production'),
    CONSTRAINT "SystemConfig_betLimits_object" CHECK (jsonb_typeof("betLimits") = 'object')
);

-- Unique constraints
CREATE UNIQUE INDEX "User_externalTornId_key" ON "User"("externalTornId");
CREATE INDEX "User_username_idx" ON "User"("username");
CREATE UNIQUE INDEX "WhitelistEntry_one_active_user_key" ON "WhitelistEntry"("userId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");
CREATE UNIQUE INDEX "LedgerEntry_type_referenceId_key" ON "LedgerEntry"("type", "referenceId");
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
CREATE UNIQUE INDEX "Market_winningOutcomeId_key" ON "Market"("winningOutcomeId") WHERE "winningOutcomeId" IS NOT NULL;
CREATE UNIQUE INDEX "Outcome_marketId_name_key" ON "Outcome"("marketId", "name");
CREATE UNIQUE INDEX "Outcome_marketId_sortOrder_key" ON "Outcome"("marketId", "sortOrder");
CREATE UNIQUE INDEX "Bet_userId_idempotencyKey_key" ON "Bet"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "Settlement_marketId_key" ON "Settlement"("marketId");
CREATE UNIQUE INDEX "Deposit_externalDepositId_key" ON "Deposit"("externalDepositId");
CREATE UNIQUE INDEX "Deposit_providerEventId_key" ON "Deposit"("providerEventId") WHERE "providerEventId" IS NOT NULL;
CREATE UNIQUE INDEX "Deposit_creditedLedgerEntryId_key" ON "Deposit"("creditedLedgerEntryId") WHERE "creditedLedgerEntryId" IS NOT NULL;
CREATE UNIQUE INDEX "Withdrawal_externalWithdrawalId_key" ON "Withdrawal"("externalWithdrawalId") WHERE "externalWithdrawalId" IS NOT NULL;
CREATE UNIQUE INDEX "Withdrawal_providerPayoutId_key" ON "Withdrawal"("providerPayoutId") WHERE "providerPayoutId" IS NOT NULL;
CREATE UNIQUE INDEX "Withdrawal_paidLedgerEntryId_key" ON "Withdrawal"("paidLedgerEntryId") WHERE "paidLedgerEntryId" IS NOT NULL;
CREATE UNIQUE INDEX "Withdrawal_refundLedgerEntryId_key" ON "Withdrawal"("refundLedgerEntryId") WHERE "refundLedgerEntryId" IS NOT NULL;
CREATE UNIQUE INDEX "Withdrawal_userId_idempotencyKey_key" ON "Withdrawal"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "Withdrawal_paid_providerPayoutId_once" ON "Withdrawal"("providerPayoutId") WHERE "status" = 'PAID';
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- Indexes
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "WhitelistEntry_userId_status_idx" ON "WhitelistEntry"("userId", "status");
CREATE INDEX "WhitelistEntry_status_createdAt_idx" ON "WhitelistEntry"("status", "createdAt");
CREATE INDEX "Wallet_status_idx" ON "Wallet"("status");
CREATE INDEX "LedgerEntry_userId_createdAt_idx" ON "LedgerEntry"("userId", "createdAt");
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");
CREATE INDEX "LedgerEntry_referenceType_referenceId_idx" ON "LedgerEntry"("referenceType", "referenceId");
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");
CREATE INDEX "Event_category_idx" ON "Event"("category");
CREATE INDEX "Market_eventId_idx" ON "Market"("eventId");
CREATE INDEX "Market_status_opensAt_closesAt_idx" ON "Market"("status", "opensAt", "closesAt");
CREATE INDEX "Outcome_marketId_status_idx" ON "Outcome"("marketId", "status");
CREATE INDEX "Bet_userId_placedAt_idx" ON "Bet"("userId", "placedAt");
CREATE INDEX "Bet_marketId_status_idx" ON "Bet"("marketId", "status");
CREATE INDEX "Bet_outcomeId_status_idx" ON "Bet"("outcomeId", "status");
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt");
CREATE INDEX "Deposit_status_idx" ON "Deposit"("status");
CREATE INDEX "Withdrawal_userId_requestedAt_idx" ON "Withdrawal"("userId", "requestedAt");
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");
CREATE INDEX "AdminUser_status_idx" ON "AdminUser"("status");
CREATE INDEX "AuditLog_actorType_createdAt_idx" ON "AuditLog"("actorType", "createdAt");
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "ReconciliationSnapshot_status_checkedAt_idx" ON "ReconciliationSnapshot"("status", "checkedAt");
CREATE INDEX "SystemConfig_globalBettingStatus_idx" ON "SystemConfig"("globalBettingStatus");

-- Foreign keys
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_addedByAdminId_fkey" FOREIGN KEY ("addedByAdminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_removedByAdminId_fkey" FOREIGN KEY ("removedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Market" ADD CONSTRAINT "Market_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Market" ADD CONSTRAINT "Market_winningOutcomeId_fkey" FOREIGN KEY ("winningOutcomeId") REFERENCES "Outcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "Outcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_winningOutcomeId_fkey" FOREIGN KEY ("winningOutcomeId") REFERENCES "Outcome"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_startedByAdminId_fkey" FOREIGN KEY ("startedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_creditedLedgerEntryId_fkey" FOREIGN KEY ("creditedLedgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_paidLedgerEntryId_fkey" FOREIGN KEY ("paidLedgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_refundLedgerEntryId_fkey" FOREIGN KEY ("refundLedgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "SystemConfig" ("key", "globalBettingStatus", "betLimits", "updatedAt")
VALUES (
    'production',
    'ACTIVE',
    '{"minBet":"1","maxBet":"5","maxPayoutPerBet":"25","maxMarketLiability":"100","maxUserOpenExposure":"25"}'::jsonb,
    CURRENT_TIMESTAMP
);

-- Immutability triggers for ledger and bet financial fields.
CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'LedgerEntry is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_no_update"
BEFORE UPDATE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_entry_mutation();

CREATE TRIGGER "LedgerEntry_no_delete"
BEFORE DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_entry_mutation();

CREATE OR REPLACE FUNCTION prevent_unauthorized_wallet_balance_mutation()
RETURNS trigger AS $$
BEGIN
    IF OLD."availableBalance" IS DISTINCT FROM NEW."availableBalance"
       OR OLD."pendingWithdrawal" IS DISTINCT FROM NEW."pendingWithdrawal" THEN
        IF current_setting('app.wallet_mutation_allowed', true) IS DISTINCT FROM 'on'
           OR current_setting('app.wallet_mutation_context', true) IS DISTINCT FROM 'ledger-backed-wallet-service' THEN
            RAISE EXCEPTION 'Wallet balance can only be changed by wallet transaction service';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Wallet_balance_guard"
BEFORE UPDATE ON "Wallet"
FOR EACH ROW EXECUTE FUNCTION prevent_unauthorized_wallet_balance_mutation();

CREATE OR REPLACE FUNCTION prevent_bet_financial_field_mutation()
RETURNS trigger AS $$
BEGIN
    IF OLD."stake" IS DISTINCT FROM NEW."stake"
       OR OLD."oddsSnapshot" IS DISTINCT FROM NEW."oddsSnapshot"
       OR OLD."potentialPayout" IS DISTINCT FROM NEW."potentialPayout"
       OR OLD."userId" IS DISTINCT FROM NEW."userId"
       OR OLD."eventId" IS DISTINCT FROM NEW."eventId"
       OR OLD."marketId" IS DISTINCT FROM NEW."marketId"
       OR OLD."outcomeId" IS DISTINCT FROM NEW."outcomeId" THEN
        RAISE EXCEPTION 'Bet accepted financial fields are immutable';
    END IF;
    IF OLD."status" IN ('WON', 'LOST', 'VOID')
       AND (OLD."status" IS DISTINCT FROM NEW."status"
            OR OLD."settledAt" IS DISTINCT FROM NEW."settledAt") THEN
        RAISE EXCEPTION 'Settled bet result is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Bet_financial_fields_no_update"
BEFORE UPDATE ON "Bet"
FOR EACH ROW EXECUTE FUNCTION prevent_bet_financial_field_mutation();
