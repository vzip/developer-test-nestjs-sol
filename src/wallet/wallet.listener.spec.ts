import { Test, TestingModule } from '@nestjs/testing';
import { WalletListener } from './wallet.listener';
import { RedisService } from '../redis/redis.service';
import { WalletBalanceChangedEvent } from './events/wallet-balance-changed.event';

const mockRedis = {
  lpush: jest.fn(),
  ltrim: jest.fn(),
};

describe('WalletListener', () => {
  let listener: WalletListener;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletListener,
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    listener = module.get<WalletListener>(WalletListener);
  });

  describe('handleBalanceChanged', () => {
    const event: WalletBalanceChangedEvent = {
      address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      network: 'solana',
      symbol: 'SOL',
      previousBalance: '1.000000',
      currentBalance: '2.000000',
      detectedAt: 1700000000000,
    };

    it('should store alert in Redis list', async () => {
      await listener.handleBalanceChanged(event);

      expect(mockRedis.lpush).toHaveBeenCalledWith(
        'wallet:alerts',
        JSON.stringify(event),
      );
    });

    it('should trim alerts list to max 50', async () => {
      await listener.handleBalanceChanged(event);

      expect(mockRedis.ltrim).toHaveBeenCalledWith('wallet:alerts', 0, 49);
    });

    it('should not throw on Redis failure', async () => {
      mockRedis.lpush.mockRejectedValue(new Error('Redis down'));

      await expect(
        listener.handleBalanceChanged(event),
      ).resolves.not.toThrow();
    });
  });
});
