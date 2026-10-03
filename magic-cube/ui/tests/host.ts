// Development-only SDK host fixture: exercises the real entry point without touching a workspace.
import { blankSetup, mappingsForSetup } from '../../shared/setup';
if (!import.meta.env.DEV) throw new Error('The test host only runs in development');
const channel = 'drift-beacon-plugin';
const frame = document.querySelector('iframe')!;
const folder = 'M10 4H2V20H22V6H12Z';
const categories = [{id:'work',name:'Work',color:'#38bdf8'}, {id:'creative',name:'Creative',color:'#c084fc'}].map((c,i)=>({...c,sortOrder:i,description:null,icon:'folder',iconPath:folder}));
const activities = [{id:'tax',name:'Tax return',categoryId:'work',trackingType:'span'}, {id:'write',name:'Write proposal',categoryId:'work',trackingType:'span'}, {id:'guitar',name:'Guitar',categoryId:'creative',trackingType:'span'}, {id:'water',name:'Water plants',categoryId:null,trackingType:'point'}].map((a,i)=>({...a,sortOrder:i,description:null,icon:'folder',iconPath:folder,color:categories.find(c=>c.id===a.categoryId)?.color??'#fbbf24',archived:false,unit:null,goal:null,period:null,pinnedBy:[]}));
let sessions: Array<{id:string;activityId:string;type:string;status:string;memberIds:string[];startedAt:string;endedAt:null}> = [];
const duel=blankSetup('duel'); duel.duel={should:{type:'activity',id:'tax'},feel:{type:'category',id:'creative'}};
const now=new Date().toISOString();
const preset={id:'approved',name:'Weeknights',setup:duel,mode:'duel',faceMappings:mappingsForSetup(duel),autoStartEnabled:false,createdAt:now,updatedAt:now};
let storage: Record<string, any> = JSON.parse(sessionStorage.getItem('magic-cube-test-v2')??'null') ?? {settings:{presets:[preset],activePresetId:preset.id,setup:duel,autoStartEnabled:false}};
let fail=false;
const data=()=>({activities,categories,sessions});
function post(message: object){frame.contentWindow?.postMessage({channel,...message},location.origin)}
function show(){sessionStorage.setItem('magic-cube-test-v2',JSON.stringify(storage));document.querySelector('#state')!.textContent=JSON.stringify(storage,null,2)}
function push(){show();post({type:'state',storage,data:data()})}
function select(p:any){storage.settings={...storage.settings,activePresetId:p.id,setup:p.setup,autoStartEnabled:p.autoStartEnabled};push()}
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.channel!==channel)return;
 const m=event.data;
 if(m.type==='hello'){post({type:'welcome',apiVersion:'0.2',plugin:{id:'magic-cube',name:'Magic Cube',version:'1.1.0'},user:{id:'test-user',name:'Test user'},workspace:{id:'test',name:'Test workspace'},config:{},storage,data:data()});return}
 if(m.type!=='request')return;
 if(m.method==='storage.set'){
  if(fail){fail=false;post({type:'response',id:m.id,error:{code:'unavailable',message:'Test save failure'}});return}
  storage[m.params.key]=m.params.value;push();post({type:'response',id:m.id,result:null});
 }else if(m.method==='sessions.start'||m.method==='sessions.mark'){
  const s={id:crypto.randomUUID(),activityId:m.params.activityId,type:m.method==='sessions.mark'?'point':'span',status:m.method==='sessions.mark'?'completed':'live',memberIds:['test-user'],startedAt:new Date().toISOString(),endedAt:null};sessions.push(s);push();post({type:'response',id:m.id,result:s});
 }else if(m.method==='sessions.discard'){sessions=sessions.filter(s=>s.id!==m.params.sessionId);push();post({type:'response',id:m.id,result:null})}
});
const click=(id:string,fn:()=>void)=>document.getElementById(id)!.addEventListener('click',fn);
click('reload',()=>{frame.src='/index.html'});
click('many',()=>{storage.settings.presets=Array.from({length:12},(_,i)=>({...preset,id:`p-${i}`,name:i===0?'The things I keep putting off until next weekend':`Routine ${i+1}`}));select(storage.settings.presets[0])});
click('empty',()=>{storage={settings:{presets:[],activePresetId:null,setup:blankSetup(),autoStartEnabled:false}};push()});
click('hold',()=>{storage.cubeStatus={state:'held',timestamp:new Date().toISOString()};push()});
click('shake',()=>{storage.cubeStatus={state:'activated',timestamp:new Date().toISOString()};push()});
click('land',()=>{const mapping=mappingsForSetup(storage.settings.setup)['1'];const id=mapping?.type==='activity'?mapping.id:mapping?.type==='category'?activities.find(a=>a.categoryId===mapping.id&&a.trackingType==='span'&&!mapping.excludedActivityIds?.includes(a.id))?.id:null;storage.lastRoll={side:1,activityId:id??null,mapping:mapping??null,timestamp:new Date().toISOString(),presetId:storage.settings.activePresetId,startMode:null};storage.cubeStatus={state:'idle',timestamp:new Date().toISOString()};push()});
click('external',()=>{const p=storage.settings.presets.at(-1);if(p)select(p)});
click('fail',()=>{fail=true});
show();
