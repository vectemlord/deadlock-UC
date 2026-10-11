import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {Game} from '../shared/game.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rooms=new Map();
const reconnectGrace=Number(process.env.RECONNECT_GRACE_MS)||45000;
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health') {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,version:'1.2',rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.clients.size,0),spectators:[...rooms.values()].reduce((n,r)=>n+r.spectators.size,0)}));return;}
  let name; try{name=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
  if(name==='/')name='/index.html';
  const allowed=name==='/index.html'||name==='/style.css'||/^\/(src|shared|public)\/[\w./-]+$/.test(name);
  const file=path.resolve(root,`.${name}`);
  if(!allowed||name.split('/').some(part=>part==='..'||part==='.')||!file.startsWith(root+path.sep)){res.writeHead(404);res.end('Not found');return;}
  try{const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(data);}
  catch{res.writeHead(404);res.end('Not found');}
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:4096});
const send=(ws,data)=>{if(ws.readyState===1 && ws.bufferedAmount<256000)ws.send(JSON.stringify(data));};
function cleanup(room){
  if(!room.clients.size&&![...room.pending.values()].some(p=>!p.spectating)){
    for(const viewer of room.spectators.values()){send(viewer,{type:'room_closed',message:'Semua pemain sudah keluar. Room ditutup.'});viewer.room=null;viewer.spectating=false;}
    rooms.delete(room.code);
  }else if(!room.clients.has(room.host)&&room.clients.size)room.host=room.clients.keys().next().value;
}
function leave(ws,temporary=false){
  const room=rooms.get(ws.room);if(!room)return;
  if(ws.spectating)room.spectators.delete(ws.id);
  else room.clients.delete(ws.id);
  if(temporary){
    room.pending.set(ws.token,{id:ws.id,spectating:!!ws.spectating,expires:Date.now()+reconnectGrace});
    const p=room.game.players.find(p=>p.id===ws.id);
    if(p){room.game.release(p);p.input={};p.shield=0;p.boost=0;p.disconnected=true;}
  }else if(!ws.spectating){room.game.removePlayer(ws.id);}
  cleanup(room);
  ws.room=null;ws.spectating=false;
}
function expire(room){
  for(const [token,p]of room.pending){if(p.expires<=Date.now()){if(!p.spectating)room.game.removePlayer(p.id);room.pending.delete(token);}}
  cleanup(room);
}
function joined(ws,room,resumed=false){
  send(ws,{type:'joined',id:ws.id,code:room.code,spectator:!!ws.spectating,token:ws.token,resumed});
}
function resume(ws,msg){
  const room=rooms.get(String(msg.code||'').toUpperCase());
  if(room)expire(room);
  const saved=room?.pending.get(msg.token);
  if(!room||!rooms.has(room.code)||!saved){send(ws,{type:'resume_failed',message:'Sesi tidak tersedia atau batas sambung ulang 45 detik sudah habis. Silakan gabung kembali.'});return;}
  room.pending.delete(msg.token);
  ws.id=saved.id;ws.token=msg.token;ws.room=room.code;ws.spectating=saved.spectating;
  if(ws.spectating)room.spectators.set(ws.id,ws);
  else{
    room.clients.set(ws.id,ws);
    const p=room.game.players.find(p=>p.id===ws.id);if(p)p.disconnected=false;
    if(!room.clients.has(room.host))room.host=ws.id;
  }
  joined(ws,room,true);
}
wss.on('connection',ws=>{
  ws.id=randomUUID();ws.token=randomBytes(24).toString('hex');ws.alive=true;ws.window=Date.now();ws.count=0;
  ws.on('pong',()=>ws.alive=true);
  ws.on('error',()=>{});
  ws.on('message',raw=>{
    if(Date.now()-ws.window>1000){ws.window=Date.now();ws.count=0;}
    if(++ws.count>90)return;
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(!msg||typeof msg!=='object')return;
    if(msg.type==='ping'){send(ws,{type:'pong',at:msg.at});return;}
    if(msg.type==='leave'){leave(ws);return;}
    if(msg.type==='resume'&&!ws.room){resume(ws,msg);return;}
    if(msg.type==='create'||msg.type==='join'||msg.type==='spectate'){
      if(ws.room)return;
      let room,code;
      if(msg.type==='create'){
        if(rooms.size>=100){send(ws,{type:'error',message:'Server penuh. Coba beberapa saat lagi.'});return;}
        code=randomBytes(3).toString('hex').toUpperCase();
        while(rooms.has(code))code=randomBytes(3).toString('hex').toUpperCase();
        room={game:new Game(),clients:new Map(),spectators:new Map(),pending:new Map(),host:ws.id,code};rooms.set(code,room);
      }else{code=String(msg.code||'').toUpperCase();room=rooms.get(code);}
      if(!room){send(ws,{type:'error',message:'Room tidak ditemukan. Periksa kode undangan.'});return;}
      if(msg.type==='spectate'){
        if(room.spectators.size+[...room.pending.values()].filter(p=>p.spectating).length>=20){send(ws,{type:'error',message:'Slot penonton penuh (maksimal 20).'});return;}
        room.spectators.set(ws.id,ws);ws.room=code;ws.spectating=true;
        joined(ws,room);return;
      }
      if(room.game.phase==='finished'){send(ws,{type:'error',message:'Pertandingan sudah selesai. Buat room baru.'});return;}
      const humans=[0,1].map(t=>room.game.players.filter(p=>p.team===t&&!p.bot).length);
      const team=humans[0]<=humans[1]?0:1;
      if(humans[team]>=5){send(ws,{type:'error',message:'Room penuh: maksimal 10 pemain.'});return;}
      const bot=room.game.players.find(p=>p.bot&&p.team===team);if(bot)room.game.removePlayer(bot.id);
      const player=room.game.addPlayer(ws.id,msg.name,msg.role,team);
      if(!player){send(ws,{type:'error',message:'Tim penuh.'});return;}
      room.clients.set(ws.id,ws);ws.room=code;
      joined(ws,room);return;
    }
    const room=rooms.get(ws.room);if(!room||ws.spectating)return;
    if(msg.type==='input')room.game.input(ws.id,msg.input||{});
    if(msg.type==='rematch'&&room.host===ws.id)room.game.rematch();
    if(msg.type==='start'&&room.host===ws.id&&room.game.phase==='lobby'){
      if(!msg.bots && room.clients.size<2){send(ws,{type:'error',message:'Butuh minimal 2 pemain, atau aktifkan bot.'});return;}
      room.game.start(msg.bots!==false);
    }
  });
  ws.on('close',()=>leave(ws,true));
});
const tick=setInterval(()=>{
  for(const room of rooms.values()){
    expire(room);if(!rooms.has(room.code))continue;
    room.game.update(1/30);
    const data={type:'state',state:room.game.snapshot(),host:room.host,spectators:room.spectators.size};
    for(const ws of [...room.clients.values(),...room.spectators.values()])send(ws,data);
  }
},1000/30);
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},15000);
const port=Number(process.env.PORT)||7860;
server.listen(port,'0.0.0.0',()=>console.log(`DEADLOCK: Kernel Wars • http://localhost:${port}`));
function shutdown(){clearInterval(tick);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();server.close();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
