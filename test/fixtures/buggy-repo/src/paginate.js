'use strict';

/**
 * Return one page of items. `page` is 1-based.
 * Planted bug: slice end is off by one, so each page returns limit+1 items
 * and duplicates the first item of the next page.
 */
function paginate(items, page, limit) {
  const start = (page - 1) * limit;
  return items.slice(start, start + limit + 1);
}

/**
 * Red herring: looks like SQL injection, but `field` is validated against a
 * fixed whitelist before ever reaching this string.
 */
const SORTABLE_FIELDS = new Set(['name', 'created_at']);
function buildOrderClause(field) {
  if (!SORTABLE_FIELDS.has(field)) {
    throw new Error(`unsortable field: ${field}`);
  }
  return `ORDER BY ${field} ASC`;
}

module.exports = { paginate, buildOrderClause };
