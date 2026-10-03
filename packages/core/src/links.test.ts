import { describe, expect, it } from 'vitest';
import { pageUrl, parsePageUrl } from './index';

const page = '0b6f3c2e-5a1d-4c8e-9f00-123456789abc';
const block = 'ad0e7d4b-1111-4222-8333-444455556666';

describe('page links', () => {
  it('round-trips page and block ids', () => {
    expect(parsePageUrl(pageUrl(page))).toEqual({ pageId: page, blockId: null });
    expect(parsePageUrl(pageUrl(page, block))).toEqual({ pageId: page, blockId: block });
    expect(parsePageUrl(`WORKSPACE://page/${page}/`)).toEqual({ pageId: page, blockId: null });
  });

  it('rejects other URLs and malformed ids', () => {
    expect(parsePageUrl('https://example.com/page/x')).toBeNull();
    expect(parsePageUrl('workspace://settings')).toBeNull();
    expect(parsePageUrl('workspace://page/../../etc')).toBeNull();
    expect(parsePageUrl(`workspace://page/${page}#<script>`)).toEqual({
      pageId: page,
      blockId: null,
    });
  });
});
