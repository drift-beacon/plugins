import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actingFor, toggleMember } from '../shared/acting-for.ts';
import { readRollsFor } from '../shared/storage.ts';

const household = [{ id:'sam', role:'MEMBER' }, { id:'jo', role:'OWNER' }, { id:'kim', role:'MEMBER' }];

test('actingFor keeps the stored choice in its order, less anyone not in the roster, without repeats', () => {
  assert.deepEqual(actingFor(['kim','gone','sam','kim'], household), ['kim','sam']);
});
test('actingFor falls back to the owner when nothing is stored, the choice is empty or everyone in it has left', () => {
  assert.deepEqual(actingFor(undefined, household), ['jo']);
  assert.deepEqual(actingFor([], household), ['jo']);
  assert.deepEqual(actingFor(['gone'], household), ['jo']);
});
test('actingFor names the only member of a workspace of one', () => {
  assert.deepEqual(actingFor(['sam'], [{ id:'jo', role:'OWNER' }]), ['jo']);
});
test('actingFor names nobody with an empty roster', () => {
  assert.deepEqual(actingFor(['sam'], []), []);
  assert.deepEqual(actingFor(undefined, []), []);
});
test('toggleMember adds at the end, removes, and refuses to untick the last one', () => {
  assert.deepEqual(toggleMember(['jo'], 'kim'), ['jo','kim']);
  assert.deepEqual(toggleMember(['jo','kim'], 'jo'), ['kim']);
  assert.equal(toggleMember(['kim'], 'kim'), null);
});
test('readRollsFor keeps non-empty strings and reads anything else as nothing stored', () => {
  assert.deepEqual(readRollsFor(['sam', '', 3, null, 'kim']), ['sam','kim']);
  assert.equal(readRollsFor(undefined), undefined);
  assert.equal(readRollsFor('sam'), undefined);
  assert.equal(readRollsFor(['', 4]), undefined);
});
