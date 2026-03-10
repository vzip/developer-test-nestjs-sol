import { formatBalance, hasBalanceChanged } from './decimal.utils';

describe('formatBalance', () => {
  it('should convert lamports to SOL', () => {
    expect(formatBalance(1_500_000_000, 9)).toBe('1.500000');
  });

  it('should convert wei to ETH', () => {
    expect(formatBalance(1_000_000_000_000_000_000n, 18)).toBe('1.000000');
  });

  it('should handle zero', () => {
    expect(formatBalance(0, 9)).toBe('0.000000');
  });

  it('should handle string input', () => {
    expect(formatBalance('2500000000', 9)).toBe('2.500000');
  });

  it('should respect custom decimal places', () => {
    expect(formatBalance(1_500_000_000, 9, 2)).toBe('1.50');
  });

  it('should handle very small amounts without floating point errors', () => {
    expect(formatBalance(1, 9)).toBe('0.000000');
    expect(formatBalance(1, 9, 9)).toBe('0.000000001');
  });

  it('should handle large lamport values safely', () => {
    const maxSafeSol = 9_007_199_254_740_991;
    const result = formatBalance(maxSafeSol, 9);
    expect(result).toBe('9007199.254740');
  });
});

describe('hasBalanceChanged', () => {
  it('should detect any change with default threshold', () => {
    expect(hasBalanceChanged('1.000000', '1.000001')).toBe(true);
  });

  it('should return false for identical balances', () => {
    expect(hasBalanceChanged('1.000000', '1.000000')).toBe(false);
  });

  it('should respect custom threshold', () => {
    expect(hasBalanceChanged('1.000000', '1.005000', '0.01')).toBe(false);
    expect(hasBalanceChanged('1.000000', '1.020000', '0.01')).toBe(true);
  });

  it('should detect decrease as a change', () => {
    expect(hasBalanceChanged('2.000000', '1.000000')).toBe(true);
  });
});
