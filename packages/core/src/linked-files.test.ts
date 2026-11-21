import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addLinkedFolder,
  linkedFileLocation,
  linkedFileOf,
  linkedFolderNameProblem,
  listLinkedFolders,
  observeLinkedFolders,
  pathInFolder,
  relativeParts,
  removeLinkedFolder,
} from './index';

describe('linked folders', () => {
  it('added under a name, listed, observed, removed', () => {
    const doc = new Y.Doc();
    let changes = 0;
    const stop = observeLinkedFolders(doc, () => changes++);
    addLinkedFolder(doc, 'Projects', 'ada');
    addLinkedFolder(doc, 'CAD 2026', null);
    expect(listLinkedFolders(doc).map((f) => f.name)).toEqual(['CAD 2026', 'Projects']);
    expect(listLinkedFolders(doc)[1]).toMatchObject({ name: 'Projects', by: 'ada' });
    removeLinkedFolder(doc, 'CAD 2026');
    expect(listLinkedFolders(doc).map((f) => f.name)).toEqual(['Projects']);
    expect(changes).toBe(3);
    stop();
  });

  it('names: taken (in any case), dots first, slashes and spaces at the ends are refused', () => {
    const doc = new Y.Doc();
    addLinkedFolder(doc, 'Projects', null);
    expect(linkedFolderNameProblem(doc, 'projects')).toBe('“projects” is already a linked folder');
    for (const bad of ['', '.hidden', 'a/b', 'a\\b', ' lead', 'trail ', 'x'.repeat(41)]) {
      expect(linkedFolderNameProblem(doc, bad), bad).toMatch(/^Use letters/);
    }
    expect(linkedFolderNameProblem(doc, 'Rosbags_v2.1')).toBeNull();
    expect(() => addLinkedFolder(doc, 'Projects', null)).toThrow('already');
  });
});

describe('paths in a linked folder', () => {
  it('a relative path in parts; nothing that could leave the folder', () => {
    expect(relativeParts('arm/v3.step')).toEqual(['arm', 'v3.step']);
    expect(relativeParts('arm\\cad\\./v3.step')).toEqual(['arm', 'cad', 'v3.step']);
    for (const bad of [
      '',
      '/etc/passwd',
      '\\\\server\\share',
      'C:\\x',
      'a/../../b',
      '..',
      'a\0b',
    ]) {
      expect(relativeParts(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a file inside a folder, on Linux and on Windows', () => {
    expect(pathInFolder('/home/ada/work', '/home/ada/work/arm/v3.step', '/')).toBe('arm/v3.step');
    expect(pathInFolder('/home/ada/work/', '/home/ada/work/a.txt', '/')).toBe('a.txt');
    expect(pathInFolder('/home/ada/work', '/home/ada/workshop/a.txt', '/')).toBeNull();
    expect(pathInFolder('/home/ada/work', '/home/ada/work', '/')).toBeNull();
    expect(pathInFolder('C:\\Users\\Ada\\Work', 'c:\\users\\ada\\work\\Arm\\v3.STEP', '\\')).toBe(
      'Arm/v3.STEP',
    );
    expect(pathInFolder('/', '/data/run.bag', '/')).toBe('data/run.bag');
  });

  it("a block's attributes as a pointer", () => {
    expect(
      linkedFileOf({ folder: 'Projects', path: 'arm/v3.step', size: 12, modifiedAt: 5 }),
    ).toEqual({
      folder: 'Projects',
      path: 'arm/v3.step',
      name: 'v3.step',
      size: 12,
      modifiedAt: 5,
    });
    // A folder pointer can't climb out of its folder.
    expect(linkedFileOf({ folder: 'Projects', path: '../secret' })).toBeNull();
    expect(linkedFileOf({ folder: null, path: '' })).toBeNull();
    const full = linkedFileOf({ path: '/data/run.bag', name: 'Run 4' })!;
    expect(full).toMatchObject({ folder: null, name: 'Run 4', size: null });
    expect(linkedFileLocation(full)).toBe('/data/run.bag');
    expect(linkedFileLocation({ ...full, folder: 'Data', path: 'run.bag' })).toBe('Data/run.bag');
  });
});
