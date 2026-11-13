import { FACES, blankSetup, faceSlots } from "../shared/setup.ts";
import { readRollsFor } from "../shared/storage.ts";
import * as actingFor from "../shared/acting-for.ts";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
// The plugin's own Start and Mark: the real useCubeRuntime, with React and the UI context replaced by an in-memory one.
const code = ts.transpileModule(readFileSync(new URL('../ui/src/components/setup/runtime.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
let ctx, saved, errors;
const local = {
  'react': { useRef: value => ({ current: value }), useState: value => [value, next => { if (typeof next === 'string') errors.push(next); }] },
  '../../../../shared/acting-for': actingFor,
  '../../drift-beacon': { useDriftBeacon: () => ctx, saveStorage: async values => { saved.push(values); } },
  '../../hooks/useCubeViewState': { useCubeViewState: (_status, lastRoll) => ({ viewState: 'result', transientRoll: lastRoll, dismiss(){} }) },
  '../../storage': { readRollsFor },
  './catalog': { activityById: id => ({ id, name: id, trackingType: 'span' }), categoryById: () => null },
  './model': { drawPool: () => [], FACES, faceSlots },
};
new Function('require','exports',code)(id => local[id] ?? require(id), exports);

const household = [{ id:'sam', role:'MEMBER' }, { id:'jo', role:'OWNER' }, { id:'kim', role:'MEMBER' }];
const kept = { side:1, activityId:'tax', timestamp:'2026-11-13T09:00:00.000Z', presetId:null, startMode:null, mapping:{ type:'activity', id:'tax' } };
/** A UI with a kept roll; `trackOptions` is what each Start asked the activity to name. */
function ui(storage, members) {
  const data = new Map(Object.entries({ lastRoll: kept, ...storage })), trackOptions = [];
  saved = []; errors = [];
  ctx = { storage:{ get:k => data.get(k) }, members, sessions:{ get:() => undefined },
    activities:{ get:id => id === 'tax' ? { id, archived:false, track:async (...args) => { trackOptions.push(args); return { id:'session-1' }; } } : undefined } };
  return { runtime: exports.useCubeRuntime({ setup: blankSetup('manual') }), trackOptions };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Start on a kept roll names the members picked in rollsFor and records the session', async () => {
  const { runtime, trackOptions } = ui({ rollsFor:['kim','sam'] }, household);
  assert.equal(runtime.roll.canStart, true);
  runtime.track(); await settle();
  assert.deepEqual(trackOptions, [[{ members:['kim','sam'] }]]);
  assert.deepEqual(saved, [{ lastRoll:{ ...kept, startMode:'manual', sessionId:'session-1' } }]);
  assert.deepEqual(errors, []);
});
test('Start on a kept roll with nobody picked names the owner', async () => {
  const { runtime, trackOptions } = ui({}, household);
  runtime.track(); await settle();
  assert.deepEqual(trackOptions, [[{ members:['jo'] }]]);
});
// The UI client reads an app that sends no roster as `[]`.
test('with no roster, Start is disabled and sends nothing', async () => {
  const { runtime, trackOptions } = ui({ rollsFor:['kim'] }, []);
  assert.equal(runtime.roll.canStart, false);
  runtime.track(); await settle();
  assert.deepEqual(trackOptions, []);
  assert.deepEqual(saved, []);
});
