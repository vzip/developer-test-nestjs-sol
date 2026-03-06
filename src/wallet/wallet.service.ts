import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
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

const CACHE_KEYS = {
  balance: (address: string) => `balance:${address}`,
  transactions: (address: string, limit: number) => `txs:${address}:${limit}`,
  tokens: (address: string) => `tokens:${address}`,
  nfts: (address: string) => `nfts:${address}`,
  lastBalance: (address: string) => `last_balance:${address}`,
  watchlist: 'watchlist',
  alerts: 'wallet:alerts',
};

const CACHE_TTL = {
  balance: 30,      // seconds
  transactions: 60, // seconds
  tokens: 120,      // seconds
  nfts: 300,        // seconds
};

@Injectable()
export class WalletService {
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
    throw new Error('Not implemented');
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
    throw new Error('Not implemented');
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
    throw new Error('Not implemented');
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
    throw new Error('Not implemented');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TODO: Return stored balance change alerts
  //
  //   1. const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1)
  //   2. return raw.map(item => JSON.parse(item) as BalanceAlert)
  // ─────────────────────────────────────────────────────────────────────────
  async getAlerts(): Promise<BalanceAlert[]> {
    throw new Error('Not implemented');
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
    throw new Error('Not implemented');
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
    throw new Error('Not implemented');
  }
}
