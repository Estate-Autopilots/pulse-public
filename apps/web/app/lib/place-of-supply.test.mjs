// QUOTE-FIXES: the place of supply follows a client's state (place-of-supply.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAfterBuyer } from './place-of-supply.mjs';

test('a new client with no state: their first state moves the default (the company\'s own state)', () => {
  assert.equal(placeAfterBuyer('27', null, '29', '27'), '29', 'Maharashtra seller, client set to Karnataka: IGST');
  assert.equal(placeAfterBuyer(null, null, '29', '27'), '29');
  assert.equal(placeAfterBuyer('27', undefined, '27', '27'), '27');
});

test('it keeps following the client, and stays where someone set it apart', () => {
  assert.equal(placeAfterBuyer('29', '29', '33', '27'), '33', 'the client moved from Karnataka to Tamil Nadu');
  assert.equal(placeAfterBuyer('33', '29', '24', '27'), '33', 'set apart by hand: a change of client state leaves it');
  assert.equal(placeAfterBuyer('33', null, '29', '27'), '33', 'chosen before the client had a state: kept');
  assert.equal(placeAfterBuyer('29', '29', null, '27'), '29', 'a cleared state leaves the place where it was');
});
