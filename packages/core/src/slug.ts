/** `Gearbox design!` → `gearbox-design`: a published page's address, to start from. */
export const slugFromTitle = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'page';
