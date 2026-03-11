import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PublicKey } from '@solana/web3.js';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { WatchWalletDto } from './dto/watch-wallet.dto';
import {
  WalletBalance,
  Transaction,
  TransactionList,
  WatchedWalletWithBalance,
  BalanceAlert,
  TokenBalance,
  NftItem,
} from '../blockchain/types/blockchain.types';
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from './events/wallet-balance-changed.event';
import { formatBalance, hasBalanceChanged } from '../utils/decimal.utils';
import { isValidSolanaAddress } from '../utils/address.utils';

// ─── Library reference ────────────────────────────────────────────────────────
//
// ── Native balance ──────────────────────────────────────────
//
// ethers.js (this.evm):
//   const raw = await this.evm.provider.getBalance(address)     // BigInt in wei
//   formatBalance(raw, this.evm.config.decimals)
//
// web3.js (this.web3) — classic alternative:
//   const raw = await this.web3.instance.eth.getBalance(address) // BigInt in wei
//   formatBalance(raw, 18)
//
// Solana (this.sol):
//   const pk  = new PublicKey(address)
//   const raw = await this.sol.connection.getBalance(pk)         // number in lamports
//   formatBalance(raw, this.sol.decimals)
//
// TON (this.ton):
//   const addr    = this.ton.parseAddress(address)
//   const raw     = await this.ton.client.getBalance(addr)       // BigInt in nanoTON
//   formatBalance(raw, this.ton.decimals)
//
// ── Transactions ─────────────────────────────────────────────
//
// EVM Explorer API (Etherscan / BscScan / Polygonscan):
//   GET <this.evm.config.explorerApiUrl>
//     ?module=account&action=txlist
//     &address=<address>&sort=desc&page=1&offset=<limit>
//     &apikey=<this.evm.explorerApiKey>
//
// Solana:
//   const pk = new PublicKey(address)
//   await this.sol.connection.getSignaturesForAddress(pk, { limit })
//   → array of ConfirmedSignatureInfo
//
// ── Tokens & NFTs (Moralis — works for EVM and Solana) ───────
//
// EVM tokens:
//   const res = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
//     address, chain: this.moralis.evmChainId,
//   })
//   res.result → array with .token.name, .token.symbol, .value, .token.decimals
//
// Solana tokens:
//   const res = await this.moralis.sdk.SolApi.account.getSPLs({ address, network: 'mainnet' })
//
// EVM NFTs:
//   const res = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
//     address, chain: this.moralis.evmChainId,
//   })
//   res.result → array with .nft.contractAddress, .nft.name, .tokenId
//
// Solana NFTs via Metaplex (this.metaplex):
//   const owner = new PublicKey(address)
//   const nfts  = await this.metaplex.sdk.nfts().findAllByOwner({ owner })
//   nfts → array of Metadata: .name, .symbol, .mintAddress
//
// ── Utilities ────────────────────────────────────────────────
//
// Decimal.js (decimal.utils.ts):
//   formatBalance(raw, decimals, dp?)       — wei/lamports → human-readable string
//   hasBalanceChanged(prev, curr, threshold?) — detect meaningful balance change
//
// EventEmitter2 (this.events):
//   this.events.emit(WALLET_BALANCE_CHANGED, payload: WalletBalanceChangedEvent)
//
// Redis:
//   this.redis.get / set / hset / hgetall / lrange / lpush / ltrim
//
// ─────────────────────────────────────────────────────────────────────────────

interface WatchlistEntry {
  readonly address: string;
  readonly label?: string;
  readonly addedAt: number;
}

interface ParsedTransferInfo {
  readonly source?: string;
  readonly destination?: string;
  readonly lamports?: number | string;
}

interface MoralisSplToken {
  readonly mint?: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly amount?: string;
  readonly decimals?: number;
}

interface MetaplexNftResult {
  readonly mintAddress?: { toBase58(): string };
  readonly name?: string;
  readonly symbol?: string;
}

const CACHE_KEYS = {
  balance: (address: string) => `balance:${address}`,
  transactions: (address: string, limit: number) => `txs:${address}:${limit}`,
  tokens: (address: string) => `tokens:${address}`,
  nfts: (address: string) => `nfts:${address}`,
  lastBalance: (address: string) => `last_balance:${address}`,
  watchlist: 'watchlist',
  alerts: 'wallet:alerts',
} as const;

const CACHE_TTL = {
  balance: 30,
  transactions: 60,
  tokens: 120,
  nfts: 300,
} as const;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly network: string;

  constructor(
    private readonly redis: RedisService,
    private readonly evm: EvmProvider,
    private readonly sol: SolanaProvider,
    private readonly web3: Web3Provider,
    private readonly ton: TonProvider,
    private readonly moralis: MoralisProvider,
    private readonly metaplex: MetaplexProvider,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2,
  ) {
    this.network = this.configService.get<string>('NETWORK', 'ethereum');
  }

  private validateSolanaAddress(address: string): PublicKey {
    if (!isValidSolanaAddress(address)) {
      throw new BadRequestException(`Invalid Solana address: ${address}`);
    }
    return new PublicKey(address);
  }

  private static readonly TX_DELAY_MS = 5000;
  private static readonly BACKOFF_MS = 10000;
  private static readonly TIMEOUT_MS = 5 * 60 * 1000;

  private enrichFromParsed(
    tx: Transaction,
    parsed: { transaction: { message: { accountKeys: { pubkey: { toBase58(): string } }[]; instructions: unknown[] } }; meta?: { preBalances?: number[]; postBalances?: number[] } | null },
    address: string,
  ): void {
    const accountKeys = parsed.transaction.message.accountKeys;
    const signerKey = accountKeys[0]?.pubkey?.toBase58() ?? address;

    const preBalance = parsed.meta?.preBalances?.[0] ?? 0;
    const postBalance = parsed.meta?.postBalances?.[0] ?? 0;
    const diff = Math.abs(preBalance - postBalance);
    tx.value = formatBalance(diff, this.sol.decimals);
    tx.from = signerKey;

    const instructions = parsed.transaction.message.instructions as Array<
      { parsed?: { type?: string; info?: ParsedTransferInfo } }
    >;
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info as ParsedTransferInfo;
        tx.from = info.source ?? signerKey;
        tx.to = info.destination ?? '';
        tx.value = formatBalance(
          String(info.lamports ?? '0'),
          this.sol.decimals,
        );
        break;
      }
    }

    if (!tx.to) {
      tx.to = accountKeys.length > 1
        ? accountKeys[1]?.pubkey?.toBase58() ?? ''
        : '';
    }
  }

  private async enrichTransactions(
    transactions: Transaction[],
    signatures: { signature: string }[],
    address: string,
  ): Promise<void> {
    const deadline = Date.now() + WalletService.TIMEOUT_MS;

    for (let i = 0; i < signatures.length; i++) {
      let enriched = false;

      while (!enriched && Date.now() < deadline) {
        try {
          const parsed = await this.sol.connection.getParsedTransaction(
            signatures[i].signature,
            { maxSupportedTransactionVersion: 0 },
          );
          if (parsed) {
            this.enrichFromParsed(transactions[i], parsed, address);
          }
          enriched = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Enrich tx ${i}/${signatures.length} 429, backing off`);

          if (Date.now() + WalletService.BACKOFF_MS >= deadline) {
            this.logger.warn(`Timeout approaching, stopping at tx ${i}`);
            return;
          }
          await new Promise((r) => setTimeout(r, WalletService.BACKOFF_MS));
        }
      }

      if (!enriched) {
        this.logger.warn(`Timeout reached at tx ${i}/${signatures.length}`);
        return;
      }

      if (i + 1 < signatures.length) {
        await new Promise((r) => setTimeout(r, WalletService.TX_DELAY_MS));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Implement balance fetching
  //
  // Steps:
  //   1. Build cache key via CACHE_KEYS.balance(address)
  //   2. Check cache: const cached = await this.redis.get(key)
  //   3. If cache hit → parse JSON and return with cached: true
  //   4. Fetch raw balance from blockchain (pick any provider — see reference above)
  //      EVM:    this.evm  | this.web3
  //      Solana: this.sol
  //      TON:    this.ton
  //   5. Convert with formatBalance(raw, decimals)
  //   6. Build WalletBalance and cache for CACHE_TTL.balance seconds
  //   7. Return with cached: false
  // ─────────────────────────────────────────────────────────────────────────
  async getBalance(address: string): Promise<WalletBalance> {
    const pk = this.validateSolanaAddress(address);

    try {
      const key = CACHE_KEYS.balance(address);
      const cached = await this.redis.get(key);
      if (cached) {
        return { ...JSON.parse(cached), cached: true };
      }

      const lamports = await this.sol.connection.getBalance(pk);
      const balance = formatBalance(lamports, this.sol.decimals);

      const result: WalletBalance = {
        address,
        balance,
        symbol: this.sol.symbol,
        network: this.network,
        cached: false,
      };

      await this.redis.set(key, JSON.stringify(result), CACHE_TTL.balance);
      return result;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to fetch balance for ${address}`, error);
      throw new InternalServerErrorException('Failed to fetch wallet balance');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Implement transaction history fetching
  //
  // Steps:
  //   1. Build cache key via CACHE_KEYS.transactions(address, limit)
  //   2. Check cache (same pattern as getBalance)
  //   3. Fetch from blockchain (see library reference)
  //   4. Map to Transaction[] (hash, from, to, value, timestamp, status)
  //   5. Use formatBalance() for EVM tx value fields if needed
  //   6. Cache for CACHE_TTL.transactions seconds
  //   7. Return TransactionList with cached: false
  // ─────────────────────────────────────────────────────────────────────────
  async getTransactions(address: string, limit = 10): Promise<TransactionList> {
    const pk = this.validateSolanaAddress(address);

    try {
      const key = CACHE_KEYS.transactions(address, limit);
      const cached = await this.redis.get(key);
      if (cached) {
        return { ...JSON.parse(cached), cached: true };
      }

      const signatures = await this.sol.connection.getSignaturesForAddress(pk, { limit });

      const transactions: Transaction[] = signatures.map((sig) => ({
        hash: sig.signature,
        from: address,
        to: '',
        value: '0',
        timestamp: sig.blockTime ?? 0,
        status: sig.err ? 'failed' : 'success' as const,
      }));

      if (signatures.length > 0) {
        await this.enrichTransactions(transactions, signatures, address);
      }

      const result: TransactionList = {
        address,
        transactions,
        network: this.network,
        cached: false,
      };

      await this.redis.set(key, JSON.stringify(result), CACHE_TTL.transactions);
      return result;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to fetch transactions for ${address}`, error);
      throw new InternalServerErrorException('Failed to fetch transactions');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Add a wallet to the watchlist
  //
  // Redis Hash storage:
  //   await this.redis.hset(CACHE_KEYS.watchlist, dto.address,
  //     JSON.stringify({ address: dto.address, label: dto.label, addedAt: Date.now() }))
  //
  // Return: { success: true, address: dto.address }
  // ─────────────────────────────────────────────────────────────────────────
  async watchWallet(dto: WatchWalletDto): Promise<{ success: boolean; address: string }> {
    this.validateSolanaAddress(dto.address);

    try {
      await this.redis.hset(
        CACHE_KEYS.watchlist,
        dto.address,
        JSON.stringify({
          address: dto.address,
          label: dto.label,
          addedAt: Date.now(),
        }),
      );
      return { success: true, address: dto.address };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to watch wallet ${dto.address}`, error);
      throw new InternalServerErrorException('Failed to add wallet to watchlist');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return all watched wallets with balances + emit events on changes
  //
  // Steps:
  //   1. const all = await this.redis.hgetall(CACHE_KEYS.watchlist)
  //   2. Parse each value with JSON.parse
  //   3. For each wallet: fetch balance via this.getBalance(address)
  //   4. Load previous: await this.redis.get(CACHE_KEYS.lastBalance(address))
  //   5. If changed (hasBalanceChanged(prev, current)):
  //        this.events.emit(WALLET_BALANCE_CHANGED, {
  //          address, network: this.network, symbol,
  //          previousBalance: prev ?? '0', currentBalance: current,
  //          detectedAt: Date.now(),
  //        } as WalletBalanceChangedEvent)
  //   6. Persist: await this.redis.set(CACHE_KEYS.lastBalance(address), current)
  //   7. Return WatchedWalletWithBalance[]
  // ─────────────────────────────────────────────────────────────────────────
  async getWatchedWallets(): Promise<WatchedWalletWithBalance[]> {
    try {
      const all = await this.redis.hgetall(CACHE_KEYS.watchlist);
      if (!all || Object.keys(all).length === 0) return [];

      const wallets: WatchlistEntry[] = Object.values(all).map((v) => JSON.parse(v));

      const settled = await Promise.allSettled(
        wallets.map(async (w) => {
          const balanceData = await this.getBalance(w.address);
          const prev = await this.redis.get(CACHE_KEYS.lastBalance(w.address));
          const current = balanceData.balance;

          if (prev && hasBalanceChanged(prev, current)) {
            this.events.emit(WALLET_BALANCE_CHANGED, {
              address: w.address,
              network: this.network,
              symbol: this.sol.symbol,
              previousBalance: prev,
              currentBalance: current,
              detectedAt: Date.now(),
            } as WalletBalanceChangedEvent);
          }

          await this.redis.set(CACHE_KEYS.lastBalance(w.address), current);

          return {
            address: w.address,
            label: w.label,
            addedAt: w.addedAt,
            balance: current,
            symbol: balanceData.symbol,
          };
        }),
      );

      const results: WatchedWalletWithBalance[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          this.logger.error('Failed to fetch watched wallet balance', r.reason);
        }
      }
      return results;
    } catch (error) {
      this.logger.error('Failed to fetch watched wallets', error);
      throw new InternalServerErrorException('Failed to fetch watched wallets');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return stored balance change alerts
  //
  //   1. const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1)
  //   2. return raw.map(item => JSON.parse(item) as BalanceAlert)
  // ─────────────────────────────────────────────────────────────────────────
  async getAlerts(): Promise<BalanceAlert[]> {
    try {
      const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1);
      return raw.map((item) => JSON.parse(item) as BalanceAlert);
    } catch (error) {
      this.logger.error('Failed to fetch alerts', error);
      throw new InternalServerErrorException('Failed to fetch alerts');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return ERC-20 / SPL token balances for a wallet
  //
  // Use Moralis (works for both EVM and Solana):
  //
  //   EVM:
  //     const res = await this.moralis.sdk.EvmApi.token.getWalletTokenBalances({
  //       address, chain: this.moralis.evmChainId,
  //     })
  //     Map res.result to TokenBalance[]
  //       contractAddress: item.token?.contractAddress?.lowercase
  //       name:            item.token?.name
  //       symbol:          item.token?.symbol
  //       decimals:        item.token?.decimals
  //       balance:         formatBalance(item.value, item.token?.decimals ?? 18)
  //
  //   Solana:
  //     const res = await this.moralis.sdk.SolApi.account.getSPLs({
  //       address, network: 'mainnet',
  //     })
  //     Map res.result to TokenBalance[]
  //
  // Cache result for CACHE_TTL.tokens seconds
  // ─────────────────────────────────────────────────────────────────────────
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    this.validateSolanaAddress(address);

    const key = CACHE_KEYS.tokens(address);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    if (!this.moralis.isAvailable()) return [];

    try {
      const res = await this.moralis.sdk.SolApi.account.getSPL({
        address,
        network: 'mainnet',
      });

      const tokens: TokenBalance[] = (res?.raw ?? []).map((item: MoralisSplToken) => ({
        contractAddress: item.mint ?? '',
        name: item.name ?? '',
        symbol: item.symbol ?? '',
        balance: item.amount ?? '0',
        decimals: Number(item.decimals ?? 0),
        network: this.network,
      }));

      await this.redis.set(key, JSON.stringify(tokens), CACHE_TTL.tokens);
      return tokens;
    } catch (error) {
      this.logger.error(`Failed to fetch token balances for ${address}`, error);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return NFTs owned by a wallet
  //
  // EVM — use Moralis:
  //   const res = await this.moralis.sdk.EvmApi.nft.getWalletNFTs({
  //     address, chain: this.moralis.evmChainId,
  //   })
  //   Map res.result to NftItem[]
  //     contractAddress: item.nft?.contractAddress?.lowercase
  //     tokenId:         item.tokenId
  //     name:            item.nft?.name
  //     symbol:          item.nft?.symbol
  //
  // Solana — use Metaplex:
  //   const owner = new PublicKey(address)
  //   const nfts  = await this.metaplex.sdk.nfts().findAllByOwner({ owner })
  //   Map to NftItem[]
  //     mint:   nft.mintAddress.toBase58()
  //     name:   nft.name
  //     symbol: nft.symbol
  //
  // Cache result for CACHE_TTL.nfts seconds
  // ─────────────────────────────────────────────────────────────────────────
  async getNfts(address: string): Promise<NftItem[]> {
    const pk = this.validateSolanaAddress(address);

    const key = CACHE_KEYS.nfts(address);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    if (!this.metaplex.isAvailable()) return [];

    try {
      const nfts = await this.metaplex.sdk.nfts().findAllByOwner({ owner: pk });

      const items: NftItem[] = nfts.map((nft: MetaplexNftResult) => ({
        mint: nft.mintAddress?.toBase58() ?? '',
        name: nft.name ?? '',
        symbol: nft.symbol ?? '',
        network: this.network,
      }));

      await this.redis.set(key, JSON.stringify(items), CACHE_TTL.nfts);
      return items;
    } catch (error) {
      this.logger.error(`Failed to fetch NFTs for ${address}`, error);
      return [];
    }
  }
}
