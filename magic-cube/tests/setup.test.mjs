import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankSetup, evenFaces, mappingsForSetup } from '../shared/setup.ts';

test('duel assigns the opposing corners and leaves unconfigured faces empty', () => {
  const setup = blankSetup('duel'); setup.duel.should = { type: 'activity', id: 'work' };
  assert.deepEqual(Object.keys(mappingsForSetup(setup)), ['1', '2', '3']);
  setup.duel.feel = { type: 'category', id: 'rest' };
  const mappings = mappingsForSetup(setup);
  assert.equal(mappings['6'].id, 'rest'); assert.equal(Object.keys(mappings).length, 6);
});
test('shortlist preserves unequal face allocations on save and restore', () => {
  const setup = blankSetup('shortlist');
  setup.shortlist = { items: [{ type: 'activity', id: 'a' }, { type: 'activity', id: 'b' }], faces: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1, '6': 1 } };
  const saved = mappingsForSetup(setup);
  assert.equal(Object.values(saved).filter(m => m.id === 'a').length, 4);
  assert.deepEqual(mappingsForSetup(structuredClone(setup)), saved);
  assert.deepEqual(Object.values(evenFaces(4)), [0,0,1,1,2,3]);
});
test('roulette exclusions are carried into every hardware mapping and retained across mode switches', () => {
  const setup = blankSetup('roulette'); setup.roulette = 'work'; setup.rouletteOff = { work: ['a','b'] };
  const mappings = mappingsForSetup(setup);
  for (const m of Object.values(mappings)) assert.deepEqual(m.excludedActivityIds, ['a','b']);
  mappings['1'].excludedActivityIds.push('c');
  assert.deepEqual(setup.rouletteOff.work, ['a','b']);
  assert.deepEqual(mappings['2'].excludedActivityIds, ['a','b']);
  const restored = structuredClone({ ...setup, mode:'manual' });
  assert.deepEqual(mappingsForSetup({ ...restored, mode:'roulette' })['1'].excludedActivityIds, ['a','b']);
});
