import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../weather.html',import.meta.url),'utf8');
const studio=readFileSync(new URL('../weather-studio.js',import.meta.url),'utf8');
function section(start,end){const a=html.indexOf(start);if(a<0)throw Error(start);const b=html.indexOf(end,a);if(b<0)throw Error(end);return html.slice(a,b);}
test('expired and undated school notices cannot reach the ticker',()=>{
 const ctx={window:{},Date};vm.createContext(ctx);vm.runInContext(studio,ctx);
 const s={closingsOn:true,closings:[{name:'Active',status:'Closed',until:new Date(Date.now()+60000).toISOString()},{name:'Expired',status:'Closed',until:new Date(Date.now()-60000).toISOString()},{name:'Undated',status:'Closed'},{name:'Invalid',status:'Closed',until:'invalid'}]};
 expect(ctx.window.WeatherStudio.closingTicker(s)).toEqual(['Active: Closed (operator-entered)']);
 expect(ctx.window.WeatherStudio.closingTicker({...s,closingsOn:false})).toEqual([]);
});
function engine(fullscreenTile=false){
 const nodes={cdownFill:{style:{}},paused:{}};
 const state={autoRotate:true,multiView:1,rotateSec:3,rotateOrder:'seq',activeId:'a',cameras:[{id:'a'},{id:'b'},{id:'disabled'}]};
 let tick,shown;
 const ctx={state,Date,Math,document:{fullscreenElement:{id:'oWrap'}},oWrap:{_fullscreenTile:fullscreenTile?{}:null},outputCameras:()=>state.cameras.filter(c=>c.id!=='disabled'),$:id=>nodes[id],setInterval:fn=>{tick=fn;},saveState:()=>{},showCamera:c=>{shown=c;}};
 vm.createContext(ctx);vm.runInContext(section('  let paused=false,hoverPause=false','  /* ---- rendering ---- */'),ctx);
 vm.runInContext(section('  /* ---- rotation ticker ---- */','  function updatePauseVisuals()'),ctx);
 vm.runInContext('lastRotate=Date.now()-4000;',ctx);
 return {ctx,state,tick:()=>tick(),shown:()=>shown};
}
test('whole-wall fullscreen continues rotating',()=>{const e=engine();e.tick();expect(e.state.activeId).toBe('b');expect(e.shown().id).toBe('b');});
test('individual tile fullscreen holds the selected tile',()=>{const e=engine(true);e.tick();expect(e.state.activeId).toBe('a');});
test('paused rotation does not advance',()=>{const e=engine();vm.runInContext('paused=true',e.ctx);e.tick();expect(e.state.activeId).toBe('a');});
test('shuffle rejects removed or disabled cameras and matches up-next',()=>{const e=engine();e.state.rotateOrder='shuffle';vm.runInContext("shuffleBag=['disabled','removed'];",e.ctx);const result=vm.runInContext('({peek:peekNextCam().id,next:nextId(1)})',e.ctx);expect(result.peek).toBe('b');expect(result.next).toBe('b');});
test('saved camera configuration is preserved while studio defaults migrate',()=>{
 const saved={cameras:[{id:'saved',name:'My existing camera',lat:38,lon:-81,url:'https://example.com/cam.jpg',refresh:30,type:'image'}],groups:[{id:'g-general',name:'General'}],multiIds:['saved'],activeId:'saved',rotateSec:0,cfg:{radarMode:'satellite'}};
 const ctx={Math,localStorage:{getItem:()=>JSON.stringify(saved)},cameraSources:c=>[{type:c.type,url:c.url}],cameraActive:c=>c.active!==false};vm.createContext(ctx);
 vm.runInContext("const KEY='test';"+section('const THEMES=','function saveState()'),ctx);
 const s=vm.runInContext('loadState()',ctx);expect(s.cameras[0].name).toBe('My existing camera');expect(s.multiIds).toEqual(['saved']);expect(s.cfg.studio.forecast).toBe(false);expect(s.cfg.radarMode).toBe('satellite');expect(s.rotateSec).toBe(3);
});
