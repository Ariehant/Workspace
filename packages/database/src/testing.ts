import type { Property, Row } from './schema';

/** Builders for tests. */
export const prop = (
  id: string,
  type: Property['type'],
  config: Property['config'] = {},
  name = id,
): Property => ({ id, name, type, config, sortKey: id });

export const row = (
  id: string,
  values: Record<string, unknown>,
  extra: Partial<Row> = {},
): Row => ({
  id,
  title: id,
  icon: null,
  cover: null,
  sortKey: id,
  createdAt: 0,
  createdBy: null,
  updatedAt: 0,
  updatedBy: null,
  uid: 0,
  trashedAt: null,
  fullWidth: false,
  smallText: false,
  font: 'default',
  locked: false,
  isTemplate: false,
  values,
  ...extra,
});
