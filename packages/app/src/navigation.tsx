import type { PageId } from '@workspace/core';
import type { OpenPagesIn } from '@workspace/database';
import { createContext, useContext } from 'react';

export interface Navigation {
  /** Show a page or a row as the main page. */
  navigate(id: PageId): void;
  /** Open a database row the way its view asks (side peek, center or full page). */
  openRow(rowId: string, databaseId: string, mode: OpenPagesIn): void;
  /** Show a page scrolled to one of its blocks (backlinks, block links). */
  navigateToBlock(pageId: PageId, blockId: string | null): void;
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation must be used inside the app shell');
  return value;
}
