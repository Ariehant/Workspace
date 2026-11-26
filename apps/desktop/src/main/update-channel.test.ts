import { describe, expect, it } from 'vitest';
import { updateChannel } from './update-channel';

describe('the update channel', () => {
  it('follows release candidates from a release candidate, releases from a release', () => {
    expect(updateChannel('1.0.0-rc.1')).toBe('rc');
    expect(updateChannel('1.0.0')).toBe('latest');
    expect(updateChannel('1.2.3')).toBe('latest');
  });
});
