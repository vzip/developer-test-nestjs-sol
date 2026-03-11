import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { WALLET_BALANCE_CHANGED } from './events/wallet-balance-changed.event';

const VALID_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const INVALID_ADDRESS = 'not-a-valid-solana-address';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  hset: jest.fn(),
  hgetall: jest.fn(),
  lrange: jest.fn(),
  lpush: jest.fn(),
  ltrim: jest.fn(),
};

const mockConnection = {
  getBalance: jest.fn(),
  getSignaturesForAddress: jest.fn(),
  getParsedTransaction: jest.fn(),
};

const mockSol = {
  connection: mockConnection,
  symbol: 'SOL',
  decimals: 9,
};

const mockMoralis = {
  isAvailable: jest.fn(),
  sdk: {
    SolApi: {
      account: {
        getSPL: jest.fn(),
      },
    },
  },
};

const mockMetaplex = {
  isAvailable: jest.fn(),
  sdk: {
    nfts: jest.fn(),
  },
};

const mockEvents = {
  emit: jest.fn(),
};

const mockConfig = {
  get: jest.fn().mockReturnValue('solana'),
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: RedisService, useValue: mockRedis },
        { provide: EvmProvider, useValue: {} },
        { provide: SolanaProvider, useValue: mockSol },
        { provide: Web3Provider, useValue: {} },
        { provide: TonProvider, useValue: {} },
        { provide: MoralisProvider, useValue: mockMoralis },
        { provide: MetaplexProvider, useValue: mockMetaplex },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  describe('getBalance', () => {
    it('should return cached balance when available', async () => {
      const cached = JSON.stringify({
        address: VALID_ADDRESS,
        balance: '1.500000',
        symbol: 'SOL',
        network: 'solana',
        cached: false,
      });
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getBalance(VALID_ADDRESS);

      expect(result.cached).toBe(true);
      expect(result.balance).toBe('1.500000');
      expect(mockConnection.getBalance).not.toHaveBeenCalled();
    });

    it('should fetch balance from RPC when not cached', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getBalance.mockResolvedValue(1_500_000_000);

      const result = await service.getBalance(VALID_ADDRESS);

      expect(result.balance).toBe('1.500000');
      expect(result.symbol).toBe('SOL');
      expect(result.network).toBe('solana');
      expect(result.cached).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `balance:${VALID_ADDRESS}`,
        expect.any(String),
        30,
      );
    });

    it('should throw BadRequestException for invalid address', async () => {
      await expect(service.getBalance(INVALID_ADDRESS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw InternalServerErrorException on RPC failure', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getBalance.mockRejectedValue(new Error('RPC timeout'));

      await expect(service.getBalance(VALID_ADDRESS)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getTransactions', () => {
    it('should return cached transactions when available', async () => {
      const cached = JSON.stringify({
        address: VALID_ADDRESS,
        transactions: [],
        network: 'solana',
        cached: false,
      });
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getTransactions(VALID_ADDRESS, 5);

      expect(result.cached).toBe(true);
      expect(mockConnection.getSignaturesForAddress).not.toHaveBeenCalled();
    });

    it('should fetch and parse transactions from RPC', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getSignaturesForAddress.mockResolvedValue([
        {
          signature: 'sig123',
          blockTime: 1700000000,
          err: null,
        },
      ]);
      mockConnection.getParsedTransaction.mockResolvedValue({
        meta: { preBalances: [2_000_000_000], postBalances: [1_000_000_000] },
        transaction: {
          message: {
            accountKeys: [{ pubkey: { toBase58: () => 'senderAddr' } }],
            instructions: [
              {
                parsed: {
                  type: 'transfer',
                  info: {
                    source: 'senderAddr',
                    destination: VALID_ADDRESS,
                    lamports: 1_000_000_000,
                  },
                },
              },
            ],
          },
        },
      });

      const result = await service.getTransactions(VALID_ADDRESS, 1);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].hash).toBe('sig123');
      expect(result.transactions[0].from).toBe('senderAddr');
      expect(result.transactions[0].to).toBe(VALID_ADDRESS);
      expect(result.transactions[0].value).toBe('1.000000');
      expect(result.transactions[0].status).toBe('success');
      expect(result.cached).toBe(false);
    });

    it('should handle empty transaction history', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getSignaturesForAddress.mockResolvedValue([]);

      const result = await service.getTransactions(VALID_ADDRESS);

      expect(result.transactions).toHaveLength(0);
      expect(mockConnection.getParsedTransaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid address', async () => {
      await expect(service.getTransactions(INVALID_ADDRESS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw InternalServerErrorException on RPC failure', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getSignaturesForAddress.mockRejectedValue(
        new Error('RPC error'),
      );

      await expect(service.getTransactions(VALID_ADDRESS)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('watchWallet', () => {
    it('should add wallet to watchlist', async () => {
      const dto = { address: VALID_ADDRESS, label: 'Test Wallet' };

      const result = await service.watchWallet(dto);

      expect(result).toEqual({ success: true, address: VALID_ADDRESS });
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'watchlist',
        VALID_ADDRESS,
        expect.stringContaining(VALID_ADDRESS),
      );
    });

    it('should store label and timestamp in Redis', async () => {
      const dto = { address: VALID_ADDRESS, label: 'My Wallet' };

      await service.watchWallet(dto);

      const storedJson = mockRedis.hset.mock.calls[0][2];
      const stored = JSON.parse(storedJson);
      expect(stored.address).toBe(VALID_ADDRESS);
      expect(stored.label).toBe('My Wallet');
      expect(stored.addedAt).toBeGreaterThan(0);
    });

    it('should throw BadRequestException for invalid address', async () => {
      await expect(
        service.watchWallet({ address: INVALID_ADDRESS }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw InternalServerErrorException on Redis failure', async () => {
      mockRedis.hset.mockRejectedValue(new Error('Redis down'));

      await expect(
        service.watchWallet({ address: VALID_ADDRESS }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getWatchedWallets', () => {
    it('should return empty array when no wallets watched', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getWatchedWallets();

      expect(result).toEqual([]);
    });

    it('should return wallets with balances', async () => {
      mockRedis.hgetall.mockResolvedValue({
        [VALID_ADDRESS]: JSON.stringify({
          address: VALID_ADDRESS,
          label: 'Test',
          addedAt: 1700000000000,
        }),
      });
      mockRedis.get.mockImplementation((key: string) => {
        if (key.startsWith('balance:')) return null;
        if (key.startsWith('last_balance:')) return null;
        return null;
      });
      mockConnection.getBalance.mockResolvedValue(2_000_000_000);

      const result = await service.getWatchedWallets();

      expect(result).toHaveLength(1);
      expect(result[0].address).toBe(VALID_ADDRESS);
      expect(result[0].balance).toBe('2.000000');
      expect(result[0].symbol).toBe('SOL');
      expect(result[0].label).toBe('Test');
    });

    it('should emit balance changed event when balance differs', async () => {
      mockRedis.hgetall.mockResolvedValue({
        [VALID_ADDRESS]: JSON.stringify({
          address: VALID_ADDRESS,
          label: 'Test',
          addedAt: 1700000000000,
        }),
      });
      mockRedis.get.mockImplementation((key: string) => {
        if (key.startsWith('balance:')) return null;
        if (key.startsWith('last_balance:')) return '1.000000';
        return null;
      });
      mockConnection.getBalance.mockResolvedValue(2_000_000_000);

      await service.getWatchedWallets();

      expect(mockEvents.emit).toHaveBeenCalledWith(
        WALLET_BALANCE_CHANGED,
        expect.objectContaining({
          address: VALID_ADDRESS,
          previousBalance: '1.000000',
          currentBalance: '2.000000',
        }),
      );
    });

    it('should not emit event when balance unchanged', async () => {
      mockRedis.hgetall.mockResolvedValue({
        [VALID_ADDRESS]: JSON.stringify({
          address: VALID_ADDRESS,
          label: 'Test',
          addedAt: 1700000000000,
        }),
      });
      mockRedis.get.mockImplementation((key: string) => {
        if (key.startsWith('balance:')) return null;
        if (key.startsWith('last_balance:')) return '2.000000';
        return null;
      });
      mockConnection.getBalance.mockResolvedValue(2_000_000_000);

      await service.getWatchedWallets();

      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('should skip failed wallets and return the rest', async () => {
      const goodAddr = VALID_ADDRESS;
      const badAddr = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
      mockRedis.hgetall.mockResolvedValue({
        [goodAddr]: JSON.stringify({ address: goodAddr, label: 'Good', addedAt: 1 }),
        [badAddr]: JSON.stringify({ address: badAddr, label: 'Bad', addedAt: 2 }),
      });
      mockRedis.get.mockResolvedValue(null);
      mockConnection.getBalance
        .mockResolvedValueOnce(1_000_000_000)
        .mockRejectedValueOnce(new Error('RPC fail'));

      const result = await service.getWatchedWallets();

      expect(result).toHaveLength(1);
      expect(result[0].address).toBe(goodAddr);
    });
  });

  describe('getAlerts', () => {
    it('should return parsed alerts from Redis', async () => {
      const alert = {
        address: VALID_ADDRESS,
        network: 'solana',
        previousBalance: '1.000000',
        currentBalance: '2.000000',
        symbol: 'SOL',
        detectedAt: 1700000000000,
      };
      mockRedis.lrange.mockResolvedValue([JSON.stringify(alert)]);

      const result = await service.getAlerts();

      expect(result).toHaveLength(1);
      expect(result[0].address).toBe(VALID_ADDRESS);
      expect(result[0].previousBalance).toBe('1.000000');
    });

    it('should return empty array when no alerts', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      const result = await service.getAlerts();

      expect(result).toEqual([]);
    });

    it('should throw InternalServerErrorException on Redis failure', async () => {
      mockRedis.lrange.mockRejectedValue(new Error('Redis down'));

      await expect(service.getAlerts()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getTokenBalances', () => {
    it('should return cached tokens when available', async () => {
      const cached = JSON.stringify([{ contractAddress: 'mint1', name: 'Token1' }]);
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getTokenBalances(VALID_ADDRESS);

      expect(result).toHaveLength(1);
      expect(mockMoralis.sdk.SolApi.account.getSPL).not.toHaveBeenCalled();
    });

    it('should return empty array when Moralis not available', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMoralis.isAvailable.mockReturnValue(false);

      const result = await service.getTokenBalances(VALID_ADDRESS);

      expect(result).toEqual([]);
    });

    it('should fetch and cache tokens from Moralis', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMoralis.isAvailable.mockReturnValue(true);
      mockMoralis.sdk.SolApi.account.getSPL.mockResolvedValue({
        raw: [
          { mint: 'mintAddr1', name: 'USDC', symbol: 'USDC', amount: '1000000', decimals: 6 },
        ],
      });

      const result = await service.getTokenBalances(VALID_ADDRESS);

      expect(result).toHaveLength(1);
      expect(result[0].contractAddress).toBe('mintAddr1');
      expect(result[0].symbol).toBe('USDC');
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid address', async () => {
      await expect(service.getTokenBalances(INVALID_ADDRESS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return empty array on Moralis API failure', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMoralis.isAvailable.mockReturnValue(true);
      mockMoralis.sdk.SolApi.account.getSPL.mockRejectedValue(new Error('API error'));

      const result = await service.getTokenBalances(VALID_ADDRESS);

      expect(result).toEqual([]);
    });
  });

  describe('getNfts', () => {
    it('should return cached NFTs when available', async () => {
      const cached = JSON.stringify([{ mint: 'nft1', name: 'MyNFT' }]);
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getNfts(VALID_ADDRESS);

      expect(result).toHaveLength(1);
    });

    it('should return empty array when Metaplex not available', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMetaplex.isAvailable.mockReturnValue(false);

      const result = await service.getNfts(VALID_ADDRESS);

      expect(result).toEqual([]);
    });

    it('should fetch and cache NFTs from Metaplex', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMetaplex.isAvailable.mockReturnValue(true);
      const findAllByOwner = jest.fn().mockResolvedValue([
        { mintAddress: { toBase58: () => 'nftMint1' }, name: 'Cool NFT', symbol: 'CNFT' },
      ]);
      mockMetaplex.sdk.nfts.mockReturnValue({ findAllByOwner });

      const result = await service.getNfts(VALID_ADDRESS);

      expect(result).toHaveLength(1);
      expect(result[0].mint).toBe('nftMint1');
      expect(result[0].name).toBe('Cool NFT');
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('should throw BadRequestException for invalid address', async () => {
      await expect(service.getNfts(INVALID_ADDRESS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return empty array on Metaplex failure', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMetaplex.isAvailable.mockReturnValue(true);
      mockMetaplex.sdk.nfts.mockReturnValue({
        findAllByOwner: jest.fn().mockRejectedValue(new Error('Metaplex error')),
      });

      const result = await service.getNfts(VALID_ADDRESS);

      expect(result).toEqual([]);
    });
  });
});
