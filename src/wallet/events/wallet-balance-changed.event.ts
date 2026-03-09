/** Event name constant — use this when emitting and listening */
export const WALLET_BALANCE_CHANGED = 'wallet.balance.changed';

/** Payload emitted when a watched wallet's balance changes */
export class WalletBalanceChangedEvent {
  readonly address: string;
  readonly network: string;
  readonly symbol: string;
  readonly previousBalance: string;
  readonly currentBalance: string;
  readonly detectedAt: number;
}
