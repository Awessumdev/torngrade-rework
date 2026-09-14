export const LEDGER_ENTRY_TYPES = Object.freeze({
  DEPOSIT: 'DEPOSIT',
  BET_STAKE: 'BET_STAKE',
  BET_WIN: 'BET_WIN',
  BET_VOID_REFUND: 'BET_VOID_REFUND',
  WITHDRAWAL_REQUEST: 'WITHDRAWAL_REQUEST',
  WITHDRAWAL_REFUND: 'WITHDRAWAL_REFUND',
  WITHDRAWAL_PAID: 'WITHDRAWAL_PAID',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
});

export const LEDGER_DIRECTIONS = Object.freeze({
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
});

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

const DECIMAL_SCALE = 18n;
const DECIMAL_FACTOR = 10n ** DECIMAL_SCALE;

export function parseMoney(value) {
  const raw = String(value).trim();

  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) {
    throw new WalletError('INVALID_AMOUNT', 'Amount must be a positive decimal with up to 18 fractional digits.');
  }

  const [whole, fraction = ''] = raw.split('.');
  const minor = BigInt(whole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(Number(DECIMAL_SCALE), '0'));

  if (minor <= 0n) {
    throw new WalletError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }

  return minor;
}

export function moneyToString(minor) {
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  const whole = absolute / DECIMAL_FACTOR;
  const fraction = String(absolute % DECIMAL_FACTOR).padStart(Number(DECIMAL_SCALE), '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

function assertWalletActive(wallet) {
  if (!wallet) {
    throw new WalletError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  }

  if (wallet.status !== 'ACTIVE') {
    throw new WalletError('WALLET_NOT_ACTIVE', 'Wallet is not active.');
  }
}

async function withWalletTransaction(db, userId, operation) {
  return db.$transaction(async (tx) => {
    const wallet = await lockWalletForUpdate(tx, userId);
    await tx.$executeRaw`SET LOCAL app.wallet_mutation_allowed = 'on'`;
    return operation(tx, wallet);
  });
}

export async function lockWalletForUpdate(tx, userId) {
  const rows = await tx.$queryRaw`
    SELECT * FROM "Wallet"
    WHERE "userId" = ${userId}::uuid
    FOR UPDATE
  `;
  const wallet = Array.isArray(rows) ? rows[0] : rows;
  assertWalletActive(wallet);
  return wallet;
}

export async function allowWalletMutationInCurrentTransaction(tx) {
  await tx.$executeRaw`SET LOCAL app.wallet_mutation_allowed = 'on'; SET LOCAL app.wallet_mutation_context = 'ledger-backed-wallet-service'`;
}

function nextAvailableBalance(wallet, direction, amountMinor) {
  const beforeMinor = parseStoredMoney(wallet.availableBalance);
  const afterMinor = direction === LEDGER_DIRECTIONS.CREDIT
    ? beforeMinor + amountMinor
    : beforeMinor - amountMinor;

  if (afterMinor < 0n) {
    throw new WalletError('INSUFFICIENT_FUNDS', 'Available balance cannot become negative.');
  }

  return { beforeMinor, afterMinor };
}

function parseStoredMoney(value) {
  if (typeof value === 'bigint') {
    return value;
  }

  const raw = String(value).trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) {
    throw new WalletError('INVALID_STORED_AMOUNT', 'Stored wallet amount is invalid.');
  }

  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(Number(DECIMAL_SCALE), '0'));
}

function walletUpdateData(wallet, patch) {
  return {
    availableBalance: patch.availableBalance ?? wallet.availableBalance,
    pendingWithdrawal: patch.pendingWithdrawal ?? wallet.pendingWithdrawal,
    version: { increment: 1 },
  };
}

export async function createLedgerBackedBalanceChange({
  tx,
  wallet,
  type,
  direction,
  amount,
  referenceType,
  referenceId,
  idempotencyKey,
  metadata,
}) {
  const amountMinor = parseMoney(amount);
  const { beforeMinor, afterMinor } = nextAvailableBalance(wallet, direction, amountMinor);

  const ledger = await tx.ledgerEntry.create({
    data: {
      userId: wallet.userId,
      walletId: wallet.id,
      currency: wallet.currency,
      type,
      direction,
      amount,
      balanceBefore: moneyToString(beforeMinor),
      balanceAfter: moneyToString(afterMinor),
      referenceType,
      referenceId,
      idempotencyKey,
      metadata,
    },
  });

  const updatedWallet = await tx.wallet.update({
    where: { id: wallet.id },
    data: walletUpdateData(wallet, { availableBalance: moneyToString(afterMinor) }),
  });

  return { wallet: updatedWallet, ledger };
}

export async function creditDeposit(db, input) {
  return withWalletTransaction(db, input.userId, (tx, wallet) => createLedgerBackedBalanceChange({
    tx,
    wallet,
    type: LEDGER_ENTRY_TYPES.DEPOSIT,
    direction: LEDGER_DIRECTIONS.CREDIT,
    amount: input.amount,
    referenceType: 'Deposit',
    referenceId: input.depositId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  }));
}

export async function debitBetStake(db, input) {
  return withWalletTransaction(db, input.userId, (tx, wallet) => createLedgerBackedBalanceChange({
    tx,
    wallet,
    type: LEDGER_ENTRY_TYPES.BET_STAKE,
    direction: LEDGER_DIRECTIONS.DEBIT,
    amount: input.amount,
    referenceType: 'Bet',
    referenceId: input.betId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  }));
}

export async function creditBetWin(db, input) {
  return withWalletTransaction(db, input.userId, (tx, wallet) => createLedgerBackedBalanceChange({
    tx,
    wallet,
    type: LEDGER_ENTRY_TYPES.BET_WIN,
    direction: LEDGER_DIRECTIONS.CREDIT,
    amount: input.amount,
    referenceType: 'Bet',
    referenceId: input.betId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  }));
}

export async function refundVoidBet(db, input) {
  return withWalletTransaction(db, input.userId, (tx, wallet) => createLedgerBackedBalanceChange({
    tx,
    wallet,
    type: LEDGER_ENTRY_TYPES.BET_VOID_REFUND,
    direction: LEDGER_DIRECTIONS.CREDIT,
    amount: input.amount,
    referenceType: 'Bet',
    referenceId: input.betId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  }));
}

export async function requestWithdrawal(db, input) {
  return withWalletTransaction(db, input.userId, async (tx, wallet) => {
    const amountMinor = parseMoney(input.amount);
    const { beforeMinor, afterMinor } = nextAvailableBalance(wallet, LEDGER_DIRECTIONS.DEBIT, amountMinor);
    const pendingBefore = parseStoredMoney(wallet.pendingWithdrawal);
    const pendingAfter = pendingBefore + amountMinor;

    const ledger = await tx.ledgerEntry.create({
      data: {
        userId: wallet.userId,
        walletId: wallet.id,
        currency: wallet.currency,
        type: LEDGER_ENTRY_TYPES.WITHDRAWAL_REQUEST,
        direction: LEDGER_DIRECTIONS.DEBIT,
        amount: input.amount,
        balanceBefore: moneyToString(beforeMinor),
        balanceAfter: moneyToString(afterMinor),
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: walletUpdateData(wallet, {
        availableBalance: moneyToString(afterMinor),
        pendingWithdrawal: moneyToString(pendingAfter),
      }),
    });

    return { wallet: updatedWallet, ledger };
  });
}

export async function refundWithdrawal(db, input) {
  return withWalletTransaction(db, input.userId, async (tx, wallet) => {
    const amountMinor = parseMoney(input.amount);
    const { beforeMinor, afterMinor } = nextAvailableBalance(wallet, LEDGER_DIRECTIONS.CREDIT, amountMinor);
    const pendingBefore = parseStoredMoney(wallet.pendingWithdrawal);
    const pendingAfter = pendingBefore - amountMinor;

    if (pendingAfter < 0n) {
      throw new WalletError('PENDING_WITHDRAWAL_NEGATIVE', 'Pending withdrawal cannot become negative.');
    }

    const ledger = await tx.ledgerEntry.create({
      data: {
        userId: wallet.userId,
        walletId: wallet.id,
        currency: wallet.currency,
        type: LEDGER_ENTRY_TYPES.WITHDRAWAL_REFUND,
        direction: LEDGER_DIRECTIONS.CREDIT,
        amount: input.amount,
        balanceBefore: moneyToString(beforeMinor),
        balanceAfter: moneyToString(afterMinor),
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: walletUpdateData(wallet, {
        availableBalance: moneyToString(afterMinor),
        pendingWithdrawal: moneyToString(pendingAfter),
      }),
    });

    return { wallet: updatedWallet, ledger };
  });
}

export async function markWithdrawalPaid(db, input) {
  return withWalletTransaction(db, input.userId, async (tx, wallet) => {
    const amountMinor = parseMoney(input.amount);
    const pendingBefore = parseStoredMoney(wallet.pendingWithdrawal);
    const pendingAfter = pendingBefore - amountMinor;

    if (pendingAfter < 0n) {
      throw new WalletError('PENDING_WITHDRAWAL_NEGATIVE', 'Pending withdrawal cannot become negative.');
    }

    const availableMinor = parseStoredMoney(wallet.availableBalance);
    const ledger = await tx.ledgerEntry.create({
      data: {
        userId: wallet.userId,
        walletId: wallet.id,
        currency: wallet.currency,
        type: LEDGER_ENTRY_TYPES.WITHDRAWAL_PAID,
        direction: LEDGER_DIRECTIONS.DEBIT,
        amount: input.amount,
        balanceBefore: moneyToString(availableMinor),
        balanceAfter: moneyToString(availableMinor),
        referenceType: 'Withdrawal',
        referenceId: input.withdrawalId,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
    });

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: walletUpdateData(wallet, { pendingWithdrawal: moneyToString(pendingAfter) }),
    });

    return { wallet: updatedWallet, ledger };
  });
}

export async function applyAdminAdjustment(db, input) {
  const direction = input.direction === LEDGER_DIRECTIONS.DEBIT
    ? LEDGER_DIRECTIONS.DEBIT
    : LEDGER_DIRECTIONS.CREDIT;

  return withWalletTransaction(db, input.userId, (tx, wallet) => createLedgerBackedBalanceChange({
    tx,
    wallet,
    type: LEDGER_ENTRY_TYPES.ADMIN_ADJUSTMENT,
    direction,
    amount: input.amount,
    referenceType: 'AdminAdjustment',
    referenceId: input.adjustmentId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  }));
}
