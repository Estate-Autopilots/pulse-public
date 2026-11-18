// DOCS-DRIVE: the bulk actions and share roles, in a module with no imports. v1-docs.ts names them in its operation
// schemas when it loads, and doc-drive.ts is still loading at that moment whenever doc-drive.js is imported first
// (doc-drive -> routes -> v1 -> v1-docs -> doc-drive), so constants read at load time live here (LAND-CAPTAIN-7).
export const BULK_ACTIONS = ['archive', 'restore', 'addTags', 'removeTags', 'share'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const SHARE_ROLES = ['view', 'comment', 'edit'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];
