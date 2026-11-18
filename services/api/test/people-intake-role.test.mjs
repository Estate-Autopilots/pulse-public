// WL-RESCUE-2 (Sakobe, Willow Lane, 18 Nov 2026): the people intake kept "Customer Support Executive" as "Sales Executive".
// A role written in is kept; the template's own words take the standard title of their kind.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldsFor, titleOf } from '../dist/people-intake.js';

const row = (role, roleKey) => ({ n: 1, name: 'Synthetic Seller', phone: '+91 90000 00001', email: null, role, roleKey, active: true, joinedOn: '2026-08-01',
  reportsTo: null, area: null, languages: [], android: null, model: null, problems: [], action: 'update', match: { id: 'x' }, manager: null });

test('a role written in is kept; the template words take the standard title', () => {
  assert.equal(titleOf({ role: 'Customer Support Executive', roleKey: 'sales_executive' }), 'Customer Support Executive');
  assert.equal(titleOf({ role: 'Sales Manager', roleKey: 'manager' }), 'Sales Manager');
  assert.equal(titleOf({ role: 'Sales executive', roleKey: 'sales_executive' }), 'Sales Executive');
  assert.equal(titleOf({ role: 'Manager', roleKey: 'manager' }), 'Sales Manager');
  assert.equal(titleOf({ role: 'Owner-admin', roleKey: 'owner_admin' }), 'Owner');
  assert.equal(titleOf({ role: null, roleKey: 'team_lead' }), 'Sales Team Lead');
  // CI-GREEN-6: the template's bare short forms are template words too (test_people_intake's "SE").
  assert.equal(titleOf({ role: 'SE', roleKey: 'sales_executive' }), 'Sales Executive');
  assert.equal(titleOf({ role: 'TL', roleKey: 'team_lead' }), 'Sales Team Lead');
  assert.equal(titleOf({ role: 'Customer Support Exec', roleKey: 'sales_executive' }), 'Customer Support Exec');
  assert.equal(titleOf({ role: null, roleKey: null }), null);
});

test('an update moves a sales title to the role written in', () => {
  const current = { id: 'x', name: 'Synthetic Seller', role: 'Sales Executive', department: 'Sales', status: 'active' };
  assert.equal(fieldsFor(row('Customer Support Executive', 'sales_executive'), current, 'Sales').role, 'Customer Support Executive');
  const added = fieldsFor(row('Customer Support Executive', 'sales_executive'), null, 'Sales');
  assert.equal(added.role, 'Customer Support Executive');
});
