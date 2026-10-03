import { blankSetup, mappingsForSetup } from "../shared/setup.ts";
import { emptySettings } from "../shared/storage.ts";
import * as palette from "../shared/palette.ts";
import * as lights from "../main/src/lights.ts";
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(readFileSync(new URL('../main/src/index.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
const local = { './storage': { UNCATEGORIZED_ID: 'uncategorized', emptySettings }, '../../shared/setup': { mappingsForSetup }, '../../shared/palette': palette, './lights': lights };
new Function('require','exports',code)(id => local[id] ?? require(id), exports);
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(stop => stop()));
});
function host(initial = {}) {
  const data = new Map(Object.entries(initial)), commands = {}, state = new Map(); let receive, changed = () => {};
  const tracked = [], lit = [], stops = [];
  const activities = [{ id:'included', archived:false, color:'#ff0000', track:async () => { tracked.push('included'); return { id:'session-1' }; } }, { id:'excluded', archived:false, color:'#00ff00' }];
  const categories = [{ id:'work', color:'#0000ff' }];
  // The Nanoleaf plugin as the cube reaches it: every command it runs is recorded, and takeControl grants a lease.
  const nanoleaf = { command: async (name, input) => { lit.push([name, input]); return name === 'takeControl' ? { granted:true, leaseId:'lease-1' } : { released:true }; } };
  const ctx = { config:{ mqttTopic:'cube' }, log:{ info(){},warn(){},error(){} }, state:{ set:(k,v)=>state.set(k,v) }, events:{ emit(){} }, commands:{ handle:(k,f)=>commands[k]=f }, storage:{ get:k=>data.get(k), set:async (k,v)=>{data.set(k,v)}, onChange(fn){ changed = fn; } }, activities:{ get:id=>activities.find(a=>a.id===id), list:()=>activities }, categories:{ get:id=>categories.find(c=>c.id===id) }, plugins:{ get:() => nanoleaf }, onStop:fn=>stops.push(fn), mqtt:{subscribe:(_,fn)=>receive=fn} };
  exports.default.onStart(ctx);
  const stop = () => Promise.all(stops.map(fn => fn()));
  cleanups.push(stop);
  return { data, commands, tracked, lit, send:(action,side)=>receive({payload:JSON.stringify({action,side})}),
    /** A settings write from the UI, as main hears it. */
    write(settings){ data.set('settings', settings); changed('settings'); },
    stop };
}
test('external preset selection restores the exact mode settings and Track', async () => {
  const setup=blankSetup('roulette'); setup.roulette='work'; setup.rouletteOff={work:['excluded']};
  const preset={id:'p',name:'Focus',setup,autoStartEnabled:true};
  const h=host({settings:{...emptySettings(),presets:[preset]}}); await h.commands.selectPreset({preset:'Focus'});
  assert.deepEqual(h.data.get('settings').setup,setup); assert.equal(h.data.get('settings').autoStartEnabled,true);
  await h.commands.selectPreset({preset:null}); assert.equal(h.data.get('settings').activePresetId,null);
  assert.deepEqual(h.data.get('settings').setup,setup);
});
test('hardware roulette honors exclusions and associates the actual tracking session', async () => {
  const setup=blankSetup('roulette'); setup.roulette='work'; setup.rouletteOff={work:['excluded']};
  const h=host({settings:{...emptySettings(),setup,autoStartEnabled:true}});
  h.send('hold'); h.send('shake'); h.send('side_up',1); h.send('side_up',1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.tracked,['included']); assert.equal(h.data.get('lastRoll').activityId,'included');
  assert.equal(h.data.get('lastRoll').sessionId,'session-1'); assert.equal(h.data.get('lastRoll').startMode,'auto');
});
test('Pin leaves the roll waiting without starting a session', async () => {
  const setup=blankSetup();setup.manual['2']={type:'activity',id:'included'};
  const h=host({settings:{...emptySettings(),setup}});
  h.send('hold'); h.send('shake'); h.send('side_up',2);
  assert.deepEqual(h.tracked,[]); assert.equal(h.data.get('lastRoll').startMode,null);
});
test('an empty face records a JSON-safe empty roll', () => {
  const h=host(); h.send('hold');h.send('shake');h.send('side_up',6);
  assert.equal(h.data.get('lastRoll').mapping,null);assert.equal(h.data.get('lastRoll').activityId,null);
  assert.deepEqual(JSON.parse(JSON.stringify(h.data.get('lastRoll'))),h.data.get('lastRoll'));
});

/* ---- The Nanoleaf wall follows the cube ---- */
const settle = () => new Promise(resolve => setImmediate(resolve));
const effects = h => h.lit.map(([name, input]) => name === 'takeControl' ? [input.effect.type, input.effect.colors, input.effect.color] : [name, input]);
const duel = () => { const setup=blankSetup('duel'); setup.duel={ should:{type:'activity',id:'included'}, feel:{type:'category',id:'work'} }; return { ...emptySettings(), setup }; };

test('hold, shake and land show a pulse, a shuffle and a reveal of the winner in the faces\' colours', async () => {
  const h=host({settings:duel()});
  h.send('hold'); await settle(); h.send('shake'); await settle(); h.send('side_up',1); await settle();
  const colors=['#ff0000','#0000ff'];
  assert.deepEqual(effects(h),[['pulse',colors,undefined],['shuffle',colors,undefined],['reveal',colors,'#ff0000']]);
  // Each wish has its own request id, and a hold outlasts the cube's own minute of inactivity.
  assert.equal(new Set(h.lit.map(([,input])=>input.requestId)).size,3);
  assert.equal(h.lit[0][1].ttlMs,75_000);
});
test('a second shake goes back to the pulse; putting the cube down or going quiet lets the wall go', async () => {
  const h=host({settings:duel()});
  h.send('hold'); await settle(); h.send('shake'); await settle(); h.send('shake'); await settle();
  assert.deepEqual(effects(h).map(e=>e[0]),['pulse','shuffle','pulse']);
  h.send('1_min_inactivity'); await settle();
  assert.deepEqual(h.lit.at(-1),['releaseControl',{leaseId:'lease-1'}]);
  h.send('hold'); await settle(); h.send('slide',2); await settle();
  assert.deepEqual(h.lit.slice(-2).map(([name])=>name),['takeControl','releaseControl']);
});
test('a roll on an empty face lets the wall go instead of revealing', async () => {
  const setup=blankSetup(); setup.manual['2']={type:'activity',id:'included'};
  const h=host({settings:{...emptySettings(),setup}});
  h.send('hold'); await settle(); h.send('shake'); await settle(); h.send('side_up',5); await settle();
  assert.deepEqual(h.lit.map(([name])=>name),['takeControl','takeControl','releaseControl']);
});
test('the lights setting off makes no calls, and switching it off mid-hold lets the wall go', async () => {
  const off=host({settings:{...duel(),lightNanoleaf:false}});
  off.send('hold'); off.send('shake'); off.send('side_up',1); await settle();
  assert.deepEqual(off.lit,[]);
  const h=host({settings:duel()});
  h.send('hold'); await settle();
  h.write({...duel(),lightNanoleaf:false}); await settle();
  assert.deepEqual(h.lit.map(([name])=>name),['takeControl','releaseControl']);
  h.send('shake'); await settle();
  assert.equal(h.lit.length,2);
});
test('faces emptied mid-hold let the wall go; with no face mapped nothing is asked', async () => {
  const none=host(); none.send('hold'); none.send('shake'); await settle();
  assert.deepEqual(none.lit,[]);
  const h=host({settings:duel()});
  h.send('hold'); await settle();
  h.write(emptySettings()); await settle();
  assert.deepEqual(h.lit.map(([name])=>name),['takeControl','releaseControl']);
  // The cube is still in hand: faces mapped again take the wall back, in the new colours.
  h.write(duel()); await settle();
  assert.deepEqual(effects(h).at(-1),['pulse',['#ff0000','#0000ff'],undefined]);
});
test('stopping lets the wall go', async () => {
  const h=host({settings:duel()});
  h.send('hold'); await settle();
  await h.stop();
  assert.deepEqual(h.lit.at(-1),['releaseControl',{leaseId:'lease-1'}]);
});
