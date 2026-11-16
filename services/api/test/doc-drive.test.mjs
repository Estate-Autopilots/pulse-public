// DOCS-DRIVE (1893): the rules of moving and changing many docs at once that need no database: which items were sent,
// which private folders a move leaves, which folders sit under the ones moving, and what view / comment / edit mean.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanItems, foldersUnder, leftBehind, roleFlags, MAX_ITEMS } from '../dist/doc-drive.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('items come as {kind, id} or docIds / folderIds / fileIds, checked and without repeats', () => {
  assert.deepEqual(cleanItems({ items: [{ kind: 'doc', id: id(1) }], docIds: [id(1), id(2)], folderIds: [id(3)] }),
    [{ kind: 'doc', id: id(1) }, { kind: 'doc', id: id(2) }, { kind: 'folder', id: id(3) }]);
  assert.throws(() => cleanItems({}), /at least one/);
  assert.throws(() => cleanItems({ items: [{ kind: 'task', id: id(1) }] }), /docs, folders or files/);
  assert.throws(() => cleanItems({ docIds: ['not-an-id'] }), /docs, folders or files/);
  assert.throws(() => cleanItems({ docIds: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => id(i + 1)) }), /at most 200/);
});

test('a move leaves the private folders that are not above its new place', () => {
  assert.deepEqual(leftBehind([id(1)], []), [id(1)], 'out of Legal to the top: Legal is left');
  assert.deepEqual(leftBehind([id(2), id(1)], [id(1)]), [id(2)], 'from a private folder inside Legal to Legal itself');
  assert.deepEqual(leftBehind([id(1)], [id(1)]), [], 'within Legal: nobody new sees it');
  assert.deepEqual(leftBehind([], [id(1)]), [], 'into Legal: fewer people see it, no question asked');
});

test('the folders under the ones moving (a folder never goes inside itself)', () => {
  const folders = [{ id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'd', parentId: null }];
  assert.deepEqual([...foldersUnder(folders, ['a'])].sort(), ['b', 'c']);
  assert.deepEqual([...foldersUnder(folders, ['d'])], []);
});

test('view reads, comment comments too, edit changes it', () => {
  assert.deepEqual(roleFlags('view'), { canEdit: false, canComment: false });
  assert.deepEqual(roleFlags('comment'), { canEdit: false, canComment: true });
  assert.deepEqual(roleFlags('edit'), { canEdit: true, canComment: true });
  assert.deepEqual(roleFlags(undefined), { canEdit: false, canComment: true });
});
