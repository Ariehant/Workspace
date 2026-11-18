import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { Hash, Link } from 'lucide-react';
import {
  BLOCKS,
  BLOCK_GROUP_LABELS,
  CONVERTIBLE_BLOCKS,
  getBlock,
  propertyBlocks,
  searchBlocks,
  slashBlocks,
} from './registry';

const ids = (query: string) => searchBlocks(query).map((b) => b.id);

describe('block registry', () => {
  it('has unique ids and a label for every group', () => {
    expect(new Set(BLOCKS.map((b) => b.id)).size).toBe(BLOCKS.length);
    expect(getBlock('heading2')?.title).toBe('Heading 2');
    for (const block of BLOCKS) expect(BLOCK_GROUP_LABELS[block.group]).toBeTruthy();
  });

  it('keeps each group contiguous, so the slash menu shows one heading per group', () => {
    const groups = BLOCKS.map((b) => b.group).filter((g, i, all) => g !== all[i - 1]);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('offers only convertible blocks in "Turn into"', () => {
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).toContain('toggleHeading1');
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).not.toContain('divider');
    expect(CONVERTIBLE_BLOCKS.map((b) => b.id)).not.toContain('table');
  });

  it('returns everything for an empty query', () => {
    expect(ids('')).toEqual(BLOCKS.map((b) => b.id));
  });

  it('ranks title prefixes first, then keywords', () => {
    expect(ids('head').slice(0, 3)).toEqual(['heading1', 'heading2', 'heading3']);
    expect(ids('h2')).toEqual(['heading2', 'toggleHeading2']);
    expect(ids('ul')[0]).toBe('bulletList');
    expect(ids('table')[0]).toBe('table');
    expect(ids('2 col')[0]).toBe('columns2');
    expect(ids('link to')[0]).toBe('linkToPage');
    expect(ids('list')).toEqual(
      expect.arrayContaining(['todo', 'bulletList', 'orderedList', 'toggle']),
    );
  });

  it('matches subsequences and rejects nonsense', () => {
    expect(ids('qte')).toEqual(['quote']);
    expect(ids('zzz')).toEqual([]);
  });
});

describe('property commands', () => {
  const editorWith = (rowProperties?: unknown) => fakeEditor({ rowProperties });
  const added: string[] = [];
  const onRowPage = editorWith({
    types: () => [
      { type: 'relation', label: 'Relation', icon: Link },
      { type: 'number', label: 'Number', icon: Hash },
    ],
    add: (type: string) => added.push(type),
  });

  it('are offered on a row page, after the blocks, and add the property', () => {
    const blocks = slashBlocks(onRowPage);
    expect(blocks.filter((b) => b.group === 'properties').map((b) => b.id)).toEqual([
      'property:relation',
      'property:number',
    ]);
    const relation = searchBlocks('relation', blocks)[0]!;
    expect(relation.id).toBe('property:relation');
    expect(relation.group).toBe('properties');
    expect(relation.action).toBe(true);
    relation.after?.(onRowPage, {});
    expect(added).toEqual(['relation']);
    expect(searchBlocks('property', blocks).map((b) => b.id)).toEqual([
      'property:relation',
      'property:number',
    ]);
  });

  it('are not offered elsewhere, or when properties can’t be changed', () => {
    expect(propertyBlocks(editorWith())).toEqual([]);
    expect(propertyBlocks(editorWith({ types: () => [], add: () => {} }))).toEqual([]);
    expect(slashBlocks(editorWith()).filter((b) => b.group === 'properties')).toEqual([]);
  });
});

/** Enough of an editor for the slash menu's lists: services, the cursor's block, comments. */
function fakeEditor({
  rowProperties,
  text = '',
  comments = false,
}: {
  rowProperties?: unknown;
  text?: string;
  comments?: boolean;
}) {
  return {
    storage: { uiBridge: { ref: { current: { services: { rowProperties } } } } },
    state: { selection: { $from: { parent: { textContent: text } } } },
    extensionManager: {
      extensions: comments ? [{ name: 'comments', options: { host: { comment() {} } } }] : [],
    },
  } as unknown as Editor;
}

describe('commands on the block', () => {
  const search = (query: string, editor = fakeEditor({ text: `/${query}` })) =>
    searchBlocks(query, slashBlocks(editor, query)).map((b) => b.id);

  it('stay out of the unfiltered menu', () => {
    expect(search('')).toEqual(BLOCKS.map((b) => b.id));
  });

  it('are found by name: colours, turn into, duplicate, delete, dates, mentions', () => {
    expect(search('red')[0]).toBe('color:red');
    expect(search('red back')[0]).toBe('color:red_background');
    expect(search('default')).toEqual(
      expect.arrayContaining(['color:default', 'color:default_background']),
    );
    expect(search('turn into h')[0]).toBe('turnInto:heading1');
    expect(search('turnh2')[0]).toBe('turnInto:heading2');
    expect(search('turn into to-do')[0]).toBe('turnInto:todo');
    expect(search('duplicate')[0]).toBe('action:duplicate');
    expect(search('delete')[0]).toBe('action:delete');
    expect(search('today')[0]).toBe('action:today');
    expect(search('remind')[0]).toBe('action:reminder');
    expect(search('mention').slice(0, 2)).toEqual(['action:mentionPerson', 'action:mentionPage']);
    expect(search('emoji')[0]).toBe('action:emoji');
    // Blocks still come first for their own names.
    expect(search('h2')[0]).toBe('heading2');
    expect(search('quote')[0]).toBe('quote');
  });

  it('offer Comment where the page has comments and the block has text', () => {
    const query = 'comm';
    expect(search(query, fakeEditor({ text: `Torque /${query}`, comments: true }))[0]).toBe(
      'action:comment',
    );
    expect(search(query, fakeEditor({ text: `/${query}`, comments: true }))).not.toContain(
      'action:comment',
    );
    expect(search(query, fakeEditor({ text: `Torque /${query}` }))).not.toContain('action:comment');
  });

  it('only turn into blocks that convert', () => {
    const ids = slashBlocks(fakeEditor({}))
      .filter((b) => b.group === 'turnInto')
      .map((b) => b.id.replace('turnInto:', ''));
    expect(ids).toEqual(CONVERTIBLE_BLOCKS.map((b) => b.id));
  });
});
