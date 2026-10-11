import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
async function until(fn,limit=4000){const start=Date.now();while(Date.now()-start<limit){if(fn())return;await wait(20);}throw new Error('Timed out waiting for network state');}
test('real WebSocket match: 10 clients, team limit, authority, sync, 20 read-only spectators, host transfer, late spectating and cleanup',async()=>{
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'17860',RECONNECT_GRACE_MS:'350'},stdio:['ignore','pipe','pipe']});
 const clients=[];let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 try{
  await until(()=>log.includes('localhost:17860'));
  const health=await fetch('http://127.0.0.1:17860/api/health');assert.equal(health.status,200);
  assert.equal((await fetch('http://127.0.0.1:17860/server/index.js')).status,404);
  assert.equal((await fetch('http://127.0.0.1:17860/public/%2e%2e%2fserver/index.js')).status,404);
  assert.equal((await fetch('http://127.0.0.1:17860/src/%2e%2e%2fpackage.json')).status,404);
  async function client(){const ws=new WebSocket('ws://127.0.0.1:17860/ws');const c={ws,messages:[]};clients.push(c);ws.on('message',b=>{const m=JSON.parse(b);c.messages.push(m);if(m.type==='state'){c.state=m.state;c.host=m.host;c.spectators=m.spectators;}if(m.type==='joined'){c.id=m.id;c.code=m.code;c.spectator=!!m.spectator;}});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return c;}
  const host=await client();host.ws.send(JSON.stringify({type:'create',name:'Host',role:'runner'}));await until(()=>host.code);
  for(let i=1;i<10;i++){const c=await client();c.ws.send(JSON.stringify({type:'join',code:host.code,name:`P${i}`,role:'sentinel'}));await until(()=>c.id);}
  await until(()=>clients.slice(0,10).every(c=>c.state?.players.length===10));
  assert.deepEqual([0,1].map(t=>host.state.players.filter(p=>p.team===t).length),[5,5]);
  const extra=await client();extra.ws.send(JSON.stringify({type:'join',code:host.code,name:'Extra'}));await until(()=>extra.messages.some(m=>m.type==='error'));assert.match(extra.messages.find(m=>m.type==='error').message,/penuh/);
  const viewers=[];
  for(let i=0;i<20;i++){const c=await client();viewers.push(c);c.ws.send(JSON.stringify({type:'spectate',code:host.code}));await until(()=>c.id);assert.equal(c.spectator,true);}
  await until(()=>viewers.every(c=>c.state?.players.length===10&&c.spectators===20));
  assert.ok(viewers.every(c=>!c.state.players.some(p=>p.id===c.id)));
  const overflow=await client();overflow.ws.send(JSON.stringify({type:'spectate',code:host.code}));await until(()=>overflow.messages.some(m=>m.type==='error'));assert.match(overflow.messages.find(m=>m.type==='error').message,/20/);
  viewers[0].ws.send(JSON.stringify({type:'start',bots:true}));await wait(100);assert.equal(host.state.phase,'lobby');
  const healthWithViewers=await (await fetch('http://127.0.0.1:17860/api/health')).json();assert.equal(healthWithViewers.players,10);assert.equal(healthWithViewers.spectators,20);
  clients[1].ws.send(JSON.stringify({type:'start',bots:false}));await wait(100);assert.equal(host.state.phase,'lobby');
  host.ws.send(JSON.stringify({type:'start',bots:false}));await until(()=>clients.slice(0,10).every(c=>c.state.phase==='playing'));
  await until(()=>viewers.every(c=>c.state.phase==='playing'));
  const before=host.state.players.map(p=>({id:p.id,x:p.x,z:p.z,hp:p.hp}));
  viewers[0].ws.send(JSON.stringify({type:'input',id:host.id,input:{x:1,z:1,fire:true,interact:true,skill:true,score:999}}));await wait(150);
  assert.deepEqual(host.state.players.map(p=>({id:p.id,x:p.x,z:p.z,hp:p.hp})),before);assert.equal(host.state.bullets.length,0);
  const initial=host.state.players.find(p=>p.id===host.id).x;
  const interval=setInterval(()=>host.ws.send(JSON.stringify({type:'input',input:{x:1,z:0,hp:999,score:999}})),35);
  await until(()=>clients.slice(0,10).every(c=>c.state.players.find(p=>p.id===host.id).x>initial+1));clearInterval(interval);
  assert.ok(clients.slice(0,10).every(c=>c.state.scores[0]===0));assert.equal(host.state.players.find(p=>p.id===host.id).maxHp,100);
  host.ws.close();await until(()=>clients[1].host===clients[1].id&&clients[1].state.players.length===9);
  assert.ok(viewers.every(c=>c.host!==c.id));
  clients.slice(1,10).forEach(c=>c.ws.close());
  await until(()=>viewers.every(c=>c.messages.some(m=>m.type==='room_closed')));
  const botHost=await client();botHost.ws.send(JSON.stringify({type:'create',name:'BotHost'}));await until(()=>botHost.code);
  botHost.ws.send(JSON.stringify({type:'start',bots:true}));await until(()=>botHost.state?.players.length===10);
  const botIds=botHost.state.players.filter(p=>p.bot).map(p=>p.id);
  viewers[0].code=null;viewers[0].ws.send(JSON.stringify({type:'spectate',code:botHost.code}));await until(()=>viewers[0].code===botHost.code&&viewers[0].state.players.some(p=>p.id===botHost.id));
  assert.deepEqual(viewers[0].state.players.filter(p=>p.bot).map(p=>p.id),botIds);
  viewers[0].ws.send(JSON.stringify({type:'leave'}));await until(()=>botHost.spectators===0);assert.equal(botHost.state.players.length,10);
  clients.forEach(c=>{if(c.ws.readyState===1)c.ws.send(JSON.stringify({type:'leave'}));c.ws.close();});await wait(500);
  assert.equal((await (await fetch('http://127.0.0.1:17860/api/health')).json()).rooms,0);
 }finally{clients.forEach(c=>c.ws.terminate());if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}}
});

test('reconnect retains identity and room, releases locks, rejects fake tokens and expires abandoned slots',async()=>{
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'17861',RECONNECT_GRACE_MS:'1200'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const sockets=[];
 async function connect(){const ws=new WebSocket('ws://127.0.0.1:17861/ws'),c={ws,messages:[]};sockets.push(ws);ws.on('message',raw=>{const m=JSON.parse(raw);c.messages.push(m);if(m.type==='joined')Object.assign(c,m);if(m.type==='state'){c.state=m.state;c.host=m.host;}});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});c.send=m=>ws.send(JSON.stringify(m));return c;}
 try{
  await until(()=>log.includes('localhost:17861'));
  const host=await connect();host.send({type:'create',name:'Reconnect',role:'engineer'});await until(()=>host.token);
  const guest=await connect();guest.send({type:'join',code:host.code,name:'Guest'});await until(()=>guest.token);
  const viewer=await connect();viewer.send({type:'spectate',code:host.code});await until(()=>viewer.token);
  host.send({type:'start',bots:false});await until(()=>host.state?.phase==='playing');
  host.send({type:'rematch'});await wait(80);assert.equal(host.state.phase,'playing','active match cannot be reset');
  const oldTime=host.state.time;host.ws.terminate();await until(()=>guest.state?.players.find(p=>p.id===host.id)?.disconnected);
  assert.equal(guest.host,guest.id,'host transfers to connected player');
  const invalid=await connect();invalid.send({type:'resume',code:host.code,token:'wrong'});await until(()=>invalid.messages.some(m=>m.type==='resume_failed'));
  const again=await connect();again.send({type:'resume',code:host.code,token:host.token});await until(()=>again.state?.players.find(p=>p.id===host.id)?.disconnected===false);
  assert.equal(again.id,host.id);assert.equal(again.code,host.code);assert.equal(again.state.players.find(p=>p.id===host.id).role,'engineer');assert.ok(again.state.time<oldTime);assert.equal(again.state.phase,'playing');assert.ok(!JSON.stringify(again.state).includes(host.token));
  viewer.ws.terminate();await wait(60);const watchAgain=await connect();watchAgain.send({type:'resume',code:host.code,token:viewer.token});await until(()=>watchAgain.state);assert.equal(watchAgain.spectator,true);watchAgain.send({type:'rematch'});watchAgain.send({type:'input',input:{x:1,fire:true}});await wait(60);assert.equal(again.state.phase,'playing');assert.equal(again.state.players.length,2);
  guest.send({type:'leave'});await until(()=>again.state.players.length===1);again.ws.terminate();await wait(80);assert.equal((await (await fetch('http://127.0.0.1:17861/api/health')).json()).rooms,1,'room survives losing last connection');
  const last=await connect();last.send({type:'resume',code:host.code,token:host.token});await until(()=>last.state);assert.equal(last.id,host.id);last.ws.terminate();
  await until(()=>watchAgain.messages.some(m=>m.type==='room_closed'));assert.equal((await (await fetch('http://127.0.0.1:17861/api/health')).json()).rooms,0);
 }finally{sockets.forEach(ws=>ws.terminate());if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}}
});

test('host rematch resets the same room and keeps teams and spectators; others cannot reset',async()=>{
 // Accelerate only the test clock. Production still starts at 360 seconds.
 const harness="import {Game} from './shared/game.js'; const start=Game.prototype.start; Game.prototype.start=function(...args){start.apply(this,args);this.time=.3;}; await import('./server/index.js');";
 const child=spawn(process.execPath,['--input-type=module','-e',harness],{env:{...process.env,PORT:'17862'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const sockets=[];
 async function connect(){const ws=new WebSocket('ws://127.0.0.1:17862/ws'),c={ws,messages:[]};sockets.push(ws);ws.on('message',raw=>{const m=JSON.parse(raw);c.messages.push(m);if(m.type==='joined')Object.assign(c,m);if(m.type==='state'){c.state=m.state;c.host=m.host;}});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});c.send=m=>ws.send(JSON.stringify(m));return c;}
 try{
  await until(()=>log.includes('localhost:17862'));
  const host=await connect();host.send({type:'create',name:'Host',role:'engineer'});await until(()=>host.code);
  const guest=await connect();guest.send({type:'join',code:host.code,name:'Guest',role:'sentinel'});await until(()=>guest.id);
  const viewer=await connect();viewer.send({type:'spectate',code:host.code});await until(()=>viewer.id);
  host.send({type:'start',bots:true});await until(()=>[host,guest,viewer].every(c=>c.state?.phase==='finished'));
  guest.send({type:'rematch'});viewer.send({type:'rematch'});await wait(80);assert.equal(host.state.phase,'finished');
  host.send({type:'rematch'});await until(()=>[host,guest,viewer].every(c=>c.state.phase==='lobby'));
  assert.equal(host.state.time,360);assert.deepEqual(host.state.scores,[0,0]);assert.equal(host.state.players.length,2);
  assert.deepEqual(host.state.players.map(p=>[p.id,p.team,p.role]),[[host.id,0,'engineer'],[guest.id,1,'sentinel']]);
  assert.equal(viewer.code,host.code);assert.equal(viewer.host,host.id);assert.equal(viewer.state.players.some(p=>p.id===viewer.id),false);
  host.send({type:'start',bots:true});await until(()=>viewer.state.phase==='playing');assert.equal(viewer.state.players.length,10);
 }finally{sockets.forEach(ws=>ws.terminate());if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}}
});
