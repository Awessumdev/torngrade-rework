import {
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  WalletError,
  allowWalletMutationInCurrentTransaction,
  createLedgerBackedBalanceChange,
  lockWalletForUpdate,
} from './wallet-service.mjs';

export class DepositPipelineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DepositPipelineError';
    this.code = code;
  }
}

export function normalizeVerifiedDeposit(input) {
  const externalTransactionId = String(input.externalTransactionId ?? '').trim();
  const providerEventId = input.providerEventId == null ? null : String(input.providerEventId).trim();
  const currency = String(input.currency ?? 'XAN').trim().toUpperCase();

  if (!externalTransactionId) {
    throw new DepositPipelineError('INVALID_EXTERNAL_TRANSACTION_ID', 'External transaction id is required.');
  }

  if (!input.userId) {
    throw new DepositPipelineError('INVALID_USER_ID', 'User id is required.');
  }

  if (!currency) {
    throw new DepositPipelineError('INVALID_CURRENCY', 'Currency is required.');
  }

  if (input.verified !== true) {
    throw new DepositPipelineError('DEPOSIT_NOT_VERIFIED', 'Deposit must be verified before processing.');
  }

  return {
    userId: input.userId,
    externalTransactionId,
    providerEventId: providerEventId || null,
    amount: input.amount,
    currency,
    metadata: input.metadata,
  };
}

export async function processVerifiedDeposit(db, input) {
  const deposit = normalizeVerifiedDeposit(input);

  try {
    return await db.$transaction(async (tx) => {
      const existingRows = await tx.$queryRaw`
        SELECT * FROM "Deposit"
        WHERE "externalDepositId" = ${deposit.externalTransactionId}
        FOR UPDATE
      `;
      const existingDeposit = Array.isArray(existingRows) ? existingRows[0] : existingRows;

      if (existingDeposit?.status === 'COMPLETED') {
        return {
          deposit: existingDeposit,
          wallet: null,
          ledger: null,
          idempotent: true,
        };
      }

      if (existingDeposit && existingDeposit.status !== 'PENDING') {
        throw new DepositPipelineError('DEPOSIT_ALREADY_TERMINAL', 'External deposit already exists in a terminal state.');
      }

      const depositRecord = existingDeposit ?? await tx.deposit.create({
        data: {
          userId: deposit.userId,
          externalDepositId: deposit.externalTransactionId,
          providerEventId: deposit.providerEventId,
          amount: deposit.amount,
          currency: deposit.currency,
          status: 'PENDING',
        },
      });

      if (depositRecord.userId !== deposit.userId) {
        throw new DepositPipelineError('DEPOSIT_USER_MISMATCH', 'External deposit belongs to a different user.');
      }

      if (String(depositRecord.amount) !== String(deposit.amount) || depositRecord.currency !== deposit.currency) {
        throw new DepositPipelineError('DEPOSIT_AMOUNT_MISMATCH', 'External deposit amount or currency does not match.');
      }

      const wallet = await lockWalletForUpdate(tx, deposit.userId);
      if (wallet.currency !== deposit.currency) {
        throw new WalletError('WALLET_CURRENCY_MISMATCH', 'Wallet currency does not match deposit currency.');
      }

      await allowWalletMutationInCurrentTransaction(tx);
      const { wallet: updatedWallet, ledger } = await createLedgerBackedBalanceChange({
        tx,
        wallet,
        type: LEDGER_ENTRY_TYPES.DEPOSIT,
        direction: LEDGER_DIRECTIONS.CREDIT,
        amount: deposit.amount,
        referenceType: 'Deposit',
        referenceId: depositRecord.id,
        idempotencyKey: `deposit:${deposit.externalTransactionId}`,
        metadata: {
          externalTransactionId: deposit.externalTransactionId,
          providerEventId: deposit.providerEventId,
          ...deposit.metadata,
        },
      });

      const completedDeposit = await tx.deposit.update({
        where: { id: depositRecord.id },
        data: {
          status: 'COMPLETED',
          creditedLedgerEntryId: ledger.id,
          completedAt: new Date(),
          providerEventId: deposit.providerEventId ?? depositRecord.providerEventId,
        },
      });

      return {
        deposit: completedDeposit,
        wallet: updatedWallet,
        ledger,
        idempotent: false,
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return processDuplicateVerifiedDeposit(db, deposit);
    }
    throw error;
  }
}

async function processDuplicateVerifiedDeposit(db, deposit) {
  const existingDeposit = await db.deposit.findUnique({
    where: { externalDepositId: deposit.externalTransactionId },
  });

  if (existingDeposit?.status === 'COMPLETED') {
    return {
      deposit: existingDeposit,
      wallet: null,
      ledger: null,
      idempotent: true,
    };
  }

  throw new DepositPipelineError('DEPOSIT_DUPLICATE_IN_PROGRESS', 'External deposit is already being processed.');
}

function isUniqueConstraintError(error) {
  return error?.code === 'P2002'
    || error?.code === '23505'
    || /unique constraint/i.test(String(error?.message ?? ''));
}
