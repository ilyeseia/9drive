import { ApiError } from '../api/errors';
import { describeErrorDetail } from './errorDetail';

describe('describeErrorDetail', () => {
  it('summarises an API error with kind, status and code but never the server text', () => {
    const detail = describeErrorDetail(new ApiError('quota', 400, 'NO_ACCOUNT_WITH_ENOUGH_SPACE', 'secret server sentence'));
    expect(detail).toBe('quota · HTTP 400 · NO_ACCOUNT_WITH_ENOUGH_SPACE');
    expect(detail).not.toContain('secret');
  });

  it('describes non-API exceptions by name and message', () => {
    expect(describeErrorDetail(new TypeError('blob.slice is not a function'))).toBe('TypeError: blob.slice is not a function');
  });

  it('removes local file paths and keeps only the first line, truncated', () => {
    const detail = describeErrorDetail(new Error('Cannot read file:///data/user/0/app/cache/ImagePicker/a.mp4 now\nsecond line'));
    expect(detail).toBe('Error: Cannot read <file> now');
    expect(describeErrorDetail(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(160);
  });
});
