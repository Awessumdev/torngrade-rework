import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../prisma/migrations/20260913152000_initial_financial_schema/migration.sql', import.meta.url),
  'utf8',
);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('declares all required models', () => {
  for (const model of [
    'User',
    'WhitelistEntry',
    'Wallet',
    'LedgerEntry',
    'Event',
    'Market',
    'Outcome',
    'Bet',
    'Settlement',
    'Deposit',
    'Withdrawal',
    'AdminUser',
    'AuditLog',
    'ReconciliationSnapshot',
    'SystemConfig',
  ]) {
    assert.match(schema, new RegExp(`model\\s+${model}\\s+\\{`));
  }
});

test('enforces required uniqueness and idempotency constraints in Prisma schema', () => {
  assert.match(schema, /externalTornId\s+String\s+@unique/);
  assert.match(schema, /model User[\s\S]*username\s+String/m);
  assert.match(schema, /model WhitelistEntry[\s\S]*userId\s+String\s+@db\.Uuid/m);
  assert.match(schema, /externalDepositId\s+String\s+@unique/);
  assert.match(schema, /model Settlement[\s\S]*marketId\s+String\s+@unique/m);
  assert.match(schema, /@@unique\(\[type,\s*referenceId\]\)/);
  assert.match(schema, /@@unique\(\[userId,\s*idempotencyKey\]\)/);
  assert.match(schema, /providerPayoutId\s+String\?\s+@unique/);
  assert.match(schema, /paidLedgerEntryId\s+String\?\s+@unique/);
  assert.match(schema, /enum GlobalBettingStatus[\s\S]*ACTIVE[\s\S]*SUSPENDED/m);
  assert.match(schema, /model SystemConfig[\s\S]*globalBettingStatus\s+GlobalBettingStatus/m);
  assert.match(schema, /model SystemConfig[\s\S]*betLimits\s+Json/m);
});

test('adds PostgreSQL checks for financial safety', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  assert.match(migration, /"id" UUID NOT NULL DEFAULT gen_random_uuid\(\)/);
  assert.match(migration, /"Wallet_availableBalance_nonnegative" CHECK \("availableBalance" >= 0\)/);
  assert.match(migration, /"Wallet_pendingWithdrawal_nonnegative" CHECK \("pendingWithdrawal" >= 0\)/);
  assert.match(migration, /"LedgerEntry_balance_math" CHECK/);
  assert.match(migration, /"type" = 'WITHDRAWAL_PAID' AND "direction" = 'DEBIT' AND "balanceAfter" = "balanceBefore"/);
  assert.match(migration, /"Bet_stake_positive" CHECK \("stake" > 0\)/);
  assert.match(migration, /"Deposit_amount_positive" CHECK \("amount" > 0\)/);
  assert.match(migration, /"Withdrawal_amount_positive" CHECK \("amount" > 0\)/);
});

test('adds closed beta whitelist persistence constraints', () => {
  assert.match(migration, /CREATE TYPE "WhitelistStatus" AS ENUM \('ACTIVE', 'REMOVED'\)/);
  assert.match(migration, /CREATE TABLE "WhitelistEntry"/);
  assert.match(migration, /CREATE UNIQUE INDEX "WhitelistEntry_one_active_user_key" ON "WhitelistEntry"\("userId"\) WHERE "status" = 'ACTIVE'/);
  assert.match(migration, /"WhitelistEntry_removed_consistency" CHECK/);
  assert.match(migration, /"WhitelistEntry_addedByAdminId_fkey" FOREIGN KEY \("addedByAdminId"\) REFERENCES "AdminUser"\("id"\)/);
});

test('adds database triggers for immutable ledger and immutable bet financial fields', () => {
  assert.match(migration, /CREATE TRIGGER "LedgerEntry_no_update"/);
  assert.match(migration, /CREATE TRIGGER "LedgerEntry_no_delete"/);
  assert.match(migration, /CREATE TRIGGER "Wallet_balance_guard"/);
  assert.match(migration, /Wallet balance can only be changed by wallet transaction service/);
  assert.match(migration, /app\.wallet_mutation_context/);
  assert.match(migration, /ledger-backed-wallet-service/);
  assert.match(migration, /CREATE TRIGGER "Bet_financial_fields_no_update"/);
  assert.match(migration, /Bet accepted financial fields are immutable/);
  assert.match(migration, /Settled bet result is immutable/);
  assert.match(migration, /OLD\."status" IN \('WON', 'LOST', 'VOID'\)/);
});

test('uses real wallet balances and requested ledger entry types', () => {
  assert.match(schema, /availableBalance\s+Decimal\s+@default\(0\)/);
  assert.match(schema, /pendingWithdrawal\s+Decimal\s+@default\(0\)/);

  for (const type of [
    'DEPOSIT',
    'BET_STAKE',
    'BET_WIN',
    'BET_VOID_REFUND',
    'WITHDRAWAL_REQUEST',
    'WITHDRAWAL_REFUND',
    'WITHDRAWAL_PAID',
    'ADMIN_ADJUSTMENT',
  ]) {
    assert.match(schema, new RegExp(`\\b${type}\\b`));
  }
});

test('adds duplicate settlement, deposit, and paid withdrawal protections', () => {
  assert.match(migration, /CREATE UNIQUE INDEX "Settlement_marketId_key" ON "Settlement"\("marketId"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "Deposit_externalDepositId_key" ON "Deposit"\("externalDepositId"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "Deposit_providerEventId_key" ON "Deposit"\("providerEventId"\) WHERE "providerEventId" IS NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX "Withdrawal_paid_providerPayoutId_once" ON "Withdrawal"\("providerPayoutId"\) WHERE "status" = 'PAID'/);
  assert.match(migration, /"Deposit_creditedLedgerEntryId_fkey" FOREIGN KEY \("creditedLedgerEntryId"\) REFERENCES "LedgerEntry"\("id"\)/);
  assert.match(migration, /"Withdrawal_paidLedgerEntryId_fkey" FOREIGN KEY \("paidLedgerEntryId"\) REFERENCES "LedgerEntry"\("id"\)/);
});

test('adds production global betting control and configurable risk limits', () => {
  assert.match(migration, /CREATE TYPE "GlobalBettingStatus" AS ENUM \('ACTIVE', 'SUSPENDED'\)/);
  assert.match(migration, /CREATE TABLE "SystemConfig"/);
  assert.match(migration, /"SystemConfig_key_production" CHECK \("key" = 'production'\)/);
  assert.match(migration, /"SystemConfig_betLimits_object" CHECK \(jsonb_typeof\("betLimits"\) = 'object'\)/);
  assert.match(migration, /"maxBet":"5"/);
  assert.match(migration, /"maxMarketLiability":"100"/);
});

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}
