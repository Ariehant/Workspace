import { roleAllows, type Forest, type PageTreeNode, type TreeKind } from '@workspace/core';

/** A part of the sidebar: a teamspace, the pages shared with you, your private pages. */
export interface SidebarSection {
  /** The tree doc it shows (or `shared`, for pages shared with you from elsewhere). */
  id: string;
  kind: TreeKind;
  title: string;
  nodes: PageTreeNode[];
  /** The tree new top-level pages go to from here; `null` if they can't. */
  addTo: string | null;
  /** A teamspace's scope (its menu: settings, leaving). */
  scope: string | null;
}

/**
 * The sidebar's sections, in Notion's order: teamspaces (by name), Shared, Private. A
 * workspace that isn't on a server has one, "Pages", as before.
 */
export function buildSections(forest: Forest, tree: PageTreeNode[]): SidebarSection[] {
  const trees = forest.list();
  const local = trees.find((t) => t.info.kind === 'local');
  if (local) {
    return [
      {
        id: local.info.id,
        kind: 'local',
        title: 'Pages',
        nodes: tree,
        addTo: local.info.id,
        scope: null,
      },
    ];
  }
  const byHome = new Map<string, PageTreeNode[]>();
  for (const node of tree) {
    const home = node.page.home ?? '';
    let list = byHome.get(home);
    if (!list) byHome.set(home, (list = []));
    list.push(node);
  }
  const editable = (role: Parameters<typeof roleAllows>[0]) => roleAllows(role, 'edit');
  const teamspaces = trees
    .filter((t) => t.info.kind === 'teamspace')
    .sort((a, b) => a.info.name.localeCompare(b.info.name))
    .map((t): SidebarSection => ({
      id: t.info.id,
      kind: 'teamspace',
      title: t.info.name || 'Teamspace',
      nodes: byHome.get(t.info.id) ?? [],
      addTo: editable(t.info.role) ? t.info.id : null,
      scope: t.info.scope,
    }));
  // Pages shared with you whose place you can't see (else they show in that place).
  const shared = trees
    .filter((t) => t.info.kind === 'shared')
    .flatMap((t) => byHome.get(t.info.id) ?? []);
  const own = trees.filter((t) => t.info.kind === 'private');
  return [
    ...teamspaces,
    ...(shared.length > 0
      ? [
          {
            id: 'shared',
            kind: 'shared' as const,
            title: 'Shared',
            nodes: shared,
            addTo: null,
            scope: null,
          },
        ]
      : []),
    ...own.map((t): SidebarSection => ({
      id: t.info.id,
      kind: 'private',
      title: 'Private',
      nodes: byHome.get(t.info.id) ?? [],
      addTo: editable(t.info.role) ? t.info.id : null,
      scope: null,
    })),
  ];
}
