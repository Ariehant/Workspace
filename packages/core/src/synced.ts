import type * as Y from 'yjs';
import { readBlocks, type Block } from './blocks';

/**
 * A synced block's content lives in its own doc (guid = the synced block id), under
 * the same content field as pages, so the editor binds to it like to a page. Every
 * place that shows it holds a `syncedBlock` node pointing at that doc.
 */
export const SYNCED_META = 'synced';

/** Where a synced block was created (its "original"). */
export function syncedSource(doc: Y.Doc): string | null {
  return (doc.getMap<unknown>(SYNCED_META).get('sourcePageId') as string | undefined) ?? null;
}

export function setSyncedSource(doc: Y.Doc, pageId: string): void {
  doc.getMap<unknown>(SYNCED_META).set('sourcePageId', pageId);
}

/** Ids of the synced blocks a page shows. */
export function syncedBlockIds(doc: Y.Doc): string[] {
  const ids: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      const id = block.props.syncedId;
      if (block.type === 'syncedBlock' && typeof id === 'string' && !ids.includes(id)) ids.push(id);
      walk(block.children);
    }
  };
  walk(readBlocks(doc));
  return ids;
}

/** What a button (block or database property) does when clicked, step by step. */
export type ButtonStep =
  /** Insert the button's template blocks (its own doc) above or below it. */
  | { kind: 'insertBlocks'; placement: 'above' | 'below' }
  /** Add a page to a database, with property values (and open it). */
  | {
      kind: 'addPage';
      databaseId: string;
      title: string;
      values: Record<string, unknown>;
      open: boolean;
    }
  /** Set properties on the rows of a database that match a filter. */
  | {
      kind: 'editPages';
      databaseId: string;
      /** A database filter (see the database package); null for every row. */
      filter: unknown;
      values: Record<string, unknown>;
    }
  /** Database button property only: set properties on the row the button is in. */
  | { kind: 'editThisRow'; values: Record<string, unknown> }
  | { kind: 'openPage'; pageId: string }
  /** Ask first; the following steps run only if confirmed. */
  | { kind: 'confirm'; message: string };

export interface ButtonConfig {
  label: string;
  /** An option color name, or `default`. */
  color: string;
  steps: ButtonStep[];
}

/** Placeholders resolved when a template or button is used. */
export const TODAY = '@today';
export const ME = '@me';
