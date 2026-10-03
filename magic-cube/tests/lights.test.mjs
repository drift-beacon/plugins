import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLights, LEASE_MS, RENEW_EVERY_MS, SILENCE_MS } from '../main/src/lights.ts';
import { facePalette } from '../shared/palette.ts';
import { blankSetup, mappingsForSetup } from '../shared/setup.ts';

/* ---- The faces' colours ---- */

const source = {
  activity: id => ({ read:{color:'#ff0000',archived:false}, write:{color:'#FF0000',archived:false}, run:{color:'#00ff00',archived:false}, old:{color:'#123456',archived:true} })[id],
  category: id => ({ work:{color:'#0000ff'} })[id],
  uncategorized: () => '#6b7280',
};
const paletteOf = setup => facePalette(mappingsForSetup(setup), source);

test('palette: each mapped face\'s colour once, in face order, whatever the mode', () => {
  const manual=blankSetup(); manual.manual={ '1':{type:'activity',id:'run'}, '2':null, '3':{type:'category',id:'work'}, '4':{type:'activity',id:'read'}, '5':{type:'activity',id:'write'}, '6':{type:'activity',id:'run'} };
  assert.deepEqual(paletteOf(manual),['#00ff00','#0000ff','#ff0000'], 'the same colour in another case, and a repeated face, count once');
  const duel=blankSetup('duel'); duel.duel={ should:{type:'activity',id:'read'}, feel:{type:'category',id:'work'} };
  assert.deepEqual(paletteOf(duel),['#ff0000','#0000ff']);
  const shortlist=blankSetup('shortlist'); shortlist.shortlist={ items:[{type:'activity',id:'run'},{type:'activity',id:'read'}], faces:{'1':1,'2':0} };
  assert.deepEqual(paletteOf(shortlist),['#ff0000','#00ff00']);
});
test('palette: a roulette is its category\'s one colour; uncategorized takes its activities\' colour', () => {
  const roulette=blankSetup('roulette'); roulette.roulette='work';
  assert.deepEqual(paletteOf(roulette),['#0000ff']);
  roulette.roulette='uncategorized';
  assert.deepEqual(paletteOf(roulette),['#6b7280']);
  assert.deepEqual(facePalette(mappingsForSetup(roulette),{...source,uncategorized:()=>undefined}),[]);
});
test('palette: empty faces, archived activities and targets that are gone give nothing', () => {
  const manual=blankSetup(); manual.manual['1']={type:'activity',id:'old'}; manual.manual['2']={type:'activity',id:'deleted'}; manual.manual['3']={type:'category',id:'deleted'};
  assert.deepEqual(paletteOf(manual),[]);
  assert.deepEqual(paletteOf(blankSetup()),[]);
});

/* ---- The lights driver, over a scripted Nanoleaf and a clock driven by hand ---- */

const settle = () => new Promise(resolve => setImmediate(resolve));
const fail = code => Object.assign(new Error(code), { code });

function rig({ answer } = {}) {
  let now = 1_000_000, timer = null;
  const calls = [], logs = [], waiting = [];
  const command = (name, input) => {
    calls.push([name, input]);
    return new Promise((resolve, reject) => {
      const scripted = answer?.(name, input, calls.length);
      if (scripted === 'hold') waiting.push({ resolve, reject });
      else if (scripted instanceof Error) reject(scripted);
      // Like the Nanoleaf plugin: the same lease for as long as the caller holds the wall.
      else resolve(scripted ?? (name === 'takeControl' ? { granted:true, leaseId:'lease-1' } : { released:true }));
    });
  };
  const lights = createLights({
    command, now: () => now,
    log: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]) },
    setTimeout: (fn, ms) => (timer = { fn, at: now + ms }), clearTimeout: id => { if (timer === id) timer = null; },
  });
  return { lights, calls, logs, waiting, names: () => calls.map(([name]) => name), types: () => calls.map(([name, input]) => input.effect?.type ?? name),
    async advance(ms) { now += ms; if (timer && timer.at <= now) { const due = timer; timer = null; due.fn(); } await settle(); } };
}
const PULSE = { type:'pulse', colors:['red','blue'] };
const SHUFFLE = { type:'shuffle', colors:['red','blue'] };
const REVEAL = { type:'reveal', colors:['red','blue'], color:'red' };

test('lights: one request at a time, and only the latest wish waits behind it', async () => {
  const r=rig({ answer:(name,_,n) => n === 1 ? 'hold' : undefined });
  r.lights.show(PULSE); r.lights.show(SHUFFLE); r.lights.show(PULSE); r.lights.show(REVEAL);
  await settle();
  assert.deepEqual(r.types(),['pulse'], 'the first is still out');
  r.waiting[0].resolve({ granted:true, leaseId:'lease-a' });
  await settle();
  assert.deepEqual(r.types(),['pulse','reveal'], 'the shuffle and second pulse were overtaken');
  assert.deepEqual(r.calls[1][1],{ effect:{ type:'reveal', colors:['red','blue'], color:'red' }, ttlMs:LEASE_MS, requestId:r.calls[1][1].requestId });
});
test('lights: the same effect again asks nothing; release names the lease it was granted', async () => {
  const r=rig();
  r.lights.show(PULSE); await settle(); r.lights.show({ ...PULSE, colors:[...PULSE.colors] }); await settle();
  assert.deepEqual(r.types(),['pulse']);
  r.lights.release(); await settle(); r.lights.release(); await settle();
  assert.deepEqual(r.calls.slice(1),[['releaseControl',{ leaseId:'lease-1' }]]);
});
test('lights: a reveal lets go by itself, so nothing is released after it', async () => {
  const r=rig();
  r.lights.show(PULSE); await settle(); r.lights.show(REVEAL); await settle(); r.lights.release(); await settle();
  assert.deepEqual(r.types(),['pulse','reveal']);
  // And nothing renews or times out after it.
  r.lights.touch(); await r.advance(SILENCE_MS * 2);
  assert.equal(r.calls.length,2);
});
test('lights: a timeout is asked again once with the same request id; a second one may still hold the wall', async () => {
  const once=rig({ answer:(name,_,n) => n === 1 ? fail('timeout') : undefined });
  once.lights.show(REVEAL); await settle();
  assert.equal(once.calls.length,2);
  assert.equal(once.calls[0][1].requestId, once.calls[1][1].requestId);
  const twice=rig({ answer:name => name === 'takeControl' ? fail('timeout') : undefined });
  twice.lights.show(PULSE); await settle();
  assert.equal(twice.calls.length,2);
  twice.lights.release(); await settle();
  assert.deepEqual(twice.calls.at(-1),['releaseControl',{}], 'it may have run: let go of whatever the cube holds');
  assert.equal(twice.logs.filter(([level])=>level==='warn').length,1);
});
test('lights: a Nanoleaf that isn\'t there is said once, never retried, and nothing is released', async () => {
  for (const code of ['not-installed','disabled','incompatible','unavailable']) {
    const r=rig({ answer:() => fail(code) });
    r.lights.show(PULSE); await settle(); r.lights.show(SHUFFLE); await settle(); r.lights.release(); await settle();
    assert.deepEqual(r.names(),['takeControl','takeControl'], code);
    assert.deepEqual(r.logs.map(([level])=>level),['info'], code);
  }
});
test('lights: refused because someone else holds the wall: nothing to release', async () => {
  const r=rig({ answer:name => name === 'takeControl' ? { granted:false, reason:'held', holder:'integration', leaseId:null } : undefined });
  r.lights.show(PULSE); await settle(); r.lights.release(); await settle();
  assert.deepEqual(r.names(),['takeControl']);
});
test('lights: let go while the request is still out releases as soon as it answers', async () => {
  const r=rig({ answer:(name,_,n) => n === 1 ? 'hold' : undefined });
  r.lights.show(PULSE); await settle(); r.lights.release(); await settle();
  assert.deepEqual(r.names(),['takeControl']);
  r.waiting[0].resolve({ granted:true, leaseId:'lease-late' }); await settle();
  assert.deepEqual(r.calls.at(-1),['releaseControl',{ leaseId:'lease-late' }]);
});
test('lights: the cube\'s messages renew the hold, at most every 15 s, with a new request id each time', async () => {
  const r=rig();
  r.lights.show(SHUFFLE); await settle();
  // In hand for two minutes, saying something every 5 s: well past one lease.
  for (let t=0; t<120_000; t+=5000) { await r.advance(5000); r.lights.touch(); await settle(); }
  const takes=r.calls.filter(([name])=>name==='takeControl');
  assert.equal(takes.length, 1 + Math.floor(120_000 / RENEW_EVERY_MS));
  assert.ok(takes.every(([,input])=>input.effect.type==='shuffle'));
  assert.equal(new Set(takes.map(([,input])=>input.requestId)).size, takes.length);
  assert.ok(!r.names().includes('releaseControl'));
});
test('lights: 70 s without a word from the cube lets the wall go, inactivity report or not', async () => {
  const r=rig();
  r.lights.show(PULSE); await settle();
  await r.advance(SILENCE_MS - 1000); r.lights.touch(); await settle();
  await r.advance(SILENCE_MS - 1000);
  assert.ok(!r.names().includes('releaseControl'), 'a message resets the deadline');
  await r.advance(1000);
  assert.deepEqual(r.calls.at(-1),['releaseControl',{ leaseId:'lease-1' }]);
  assert.ok(SILENCE_MS < LEASE_MS);
});
test('lights: stop lets go and waits for it; errors never escape', async () => {
  const r=rig({ answer:name => name === 'releaseControl' ? fail('stopped') : undefined });
  r.lights.show(PULSE); await settle();
  await r.lights.stop();
  assert.deepEqual(r.names(),['takeControl','releaseControl']);
});
