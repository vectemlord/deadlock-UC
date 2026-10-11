import {Arena} from './arena.js';
import {Game, ARENA, BASES, CLASSES, NODES, WALLS, UPLINK, distance} from '../shared/game.js';
import {decodeState} from '../shared/codec.js';
import {SnapshotBuffer, Predictor, Telemetry, InputGate} from './netcode.js';
import {initSidebar} from './sidebar.js';
const $=s=>document.querySelector(s), esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let arena;try{arena=new Arena($('#scene'));}catch(e){$('#scene').innerHTML='<div style="padding:120px 6%;color:#e7b48c">WebGL tidak tersedia. Aktifkan akselerasi grafis browser untuk melihat arena 3D.</div>';console.error(e);}
let role='runner',mode='menu',localGame=null,state=null,myId=null,socket=null,online=false,roomCode='',hostId='',lastHud=0,lastFrame=performance.now(),accumulator=0;
let modalKind='',mouse={x:innerWidth/2,y:innerHeight/2,down:false,moved:false},keys=new Set(),pending={},touch={x:0,z:0,fire:false},lastFeed='',lastRoster='',lastSound=0,muted=true,audioContext=null,ping=0,resultsShown=false;
let spectating=false,viewerCount=0,followId='',watchRoster='';
// v1.3 netcode state: wire roster, feed events, interpolation buffer, client prediction, input gate, telemetry
const buffer=new SnapshotBuffer(),predictor=new Predictor(),telemetry=new Telemetry(),gate=new InputGate();
let roster=[],rosterV=-1,eventLog=[],aimAngle=0,rosterWaits=0;
let resumeSession=null,lastMessage=Date.now();
try{resumeSession=JSON.parse(sessionStorage.getItem('deadlock-session')||'null');}catch{}
function saveSession(value){resumeSession=value;try{if(value)sessionStorage.setItem('deadlock-session',JSON.stringify(value));else sessionStorage.removeItem('deadlock-session');}catch{}}
let name;try{name=localStorage.getItem('deadlock-name')||'Operator';}catch{name='Operator';}
const demo=new Game();demo.fillBots();demo.start(false);let demoTime=0;
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),4200);}
function sound(type){if(muted)return;try{audioContext||=new AudioContext();audioContext.resume();const osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.connect(gain);gain.connect(audioContext.destination);osc.type=type==='kill'?'sawtooth':'sine';const t=audioContext.currentTime;osc.frequency.setValueAtTime(type==='deadlock'?170:type==='score'?660:380,t);osc.frequency.exponentialRampToValueAtTime(type==='score'?990:100,t+.16);gain.gain.setValueAtTime(.045,t);gain.gain.exponentialRampToValueAtTime(.001,t+.25);osc.start(t);osc.stop(t+.25);}catch{}}
$('.sound-toggle').addEventListener('click',e=>{muted=!muted;e.currentTarget.textContent=muted?'♪':'♫';e.currentTarget.style.color=muted?'':'var(--lime)';toast(muted?'Audio dinonaktifkan':'Audio aktif');if(!muted)sound('score');});
function send(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));}
function connect(){
  const port=/^\/deadlock(?:\/|$)/.test(location.pathname)?`${location.hostname}:7860`:location.host;
  const url=`${location.protocol==='https:'?'wss':'ws'}://${port}/ws`;
  try{socket=new WebSocket(url);socket.binaryType='arraybuffer';}catch{connectionStatus(false);return;}
  socket.addEventListener('open',()=>{lastMessage=Date.now();connectionStatus(true);if(resumeSession)send({type:'resume',proto:2,...resumeSession});});
  socket.addEventListener('message',e=>{
    lastMessage=Date.now();
    if(typeof e.data!=='string'){onFrame(new Uint8Array(e.data));return;}
    telemetry.down(e.data.length,performance.now(),false);let msg;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='roster'){roster=msg.players;rosterV=msg.v;return;}
    if(msg.type==='meta'){hostId=msg.host;viewerCount=msg.spectators||0;if(modalKind==='lobby'&&state)lobbyUpdate();return;}
    if(msg.type==='events'){mergeEvents(msg);return;}
    if(msg.type==='pong'){ping=Math.round(Date.now()-msg.at);return;}
    if(msg.type==='error'){toast(msg.message);return;}
    if(msg.type==='resume_failed'){leaveMatch(false);rooms();toast(msg.message);return;}
    if(msg.type==='room_closed'){leaveMatch(false);toast(msg.message);return;}
    if(msg.type==='joined'){saveSession({code:msg.code,token:msg.token});$('#connection-banner').classList.add('hidden');buffer.clear();predictor.reset();gate.reset();eventLog=[];roster=[];rosterV=-1;if(msg.resumed&&mode==='online'&&state){toast('Terhubung kembali. Lanjutkan pertempuran!');return;}spectating=!!msg.spectator;viewerCount=0;followId='';watchRoster='';myId=msg.id;roomCode=msg.code;mode='lobby';lastRoster='';modalKind='lobby';lobby();return;}
    if(msg.type==='state'){applyState(msg.state,msg.host,msg.spectators||0);return;}
  });
  socket.addEventListener('close',()=>{
    connectionStatus(false);
    if(resumeSession){$('#connection-banner').classList.remove('hidden');keys.clear();mouse.down=false;pending={};touch={x:0,z:0,fire:false};}
    setTimeout(connect,1500);
  });
  socket.addEventListener('error',()=>connectionStatus(false));
}
function applyState(next,host,viewers){
  if(mode!=='lobby'&&mode!=='online')return;
  state=next;if(host!==undefined){hostId=host;viewerCount=viewers;}
  if(state.phase==='lobby'){if(mode==='online'){mode='lobby';resultsShown=false;lastRoster='';$('#hud').classList.add('hidden');predictor.reset();gate.reset();lobby();}lobbyUpdate();}
  else if(mode==='lobby'){beginMatch('online');}
  if(modalKind==='result'&&mode==='online')updateRematchButton();
}
// Binary state frame (protocol 2): decode against the roster, store for interpolation, reconcile prediction.
function onFrame(bytes){
  const decoded=decodeState(bytes,roster,rosterV);
  telemetry.down(bytes.length,performance.now(),!!decoded&&!decoded.stale);
  if(!decoded||decoded.stale){if(decoded?.stale)rosterWaits++;return;}
  decoded.events=eventLog;
  buffer.push(decoded,performance.now());
  applyState(decoded);
  const me=!spectating&&mode==='online'?decoded.players.find(p=>p.id===myId):null;
  if(me)predictor.reconcile(me,decoded.phase==='playing');
}
function mergeEvents(msg){
  if(msg.reset)eventLog=[];
  const known=new Set(eventLog.map(e=>e.id));
  eventLog=[...eventLog,...msg.events.filter(e=>!known.has(e.id))].slice(-12);
  if(state)state.events=eventLog;
}
function connectionStatus(value){online=value;$('#server-dot').classList.toggle('offline',!value);$('#server-status').textContent=value?'SERVER ONLINE':'PRACTICE READY';const notice=$('#room-network-note');if(notice)notice.textContent=value?'Server terhubung · WebSocket real time · 30 tick/s':'Server belum terhubung. Jalankan npm start. Mode latihan tetap tersedia.';}
connect();setInterval(()=>{if(online){if(Date.now()-lastMessage>12000){socket.close();return;}send({type:'ping',at:Date.now(),rtt:ping});}},3000);
setInterval(()=>{const stale=online&&['online','lobby'].includes(mode)&&Date.now()-lastMessage>(mode==='online'?1000:2500);const w=$('#net-warning');w.classList.toggle('hidden',!stale);if(stale)w.querySelector('b').textContent=`${((Date.now()-lastMessage)/1000).toFixed(1)}s`;},250);
function modal(content,kind='info'){$('#modal-content').innerHTML=content;$('#modal-backdrop').classList.remove('hidden');modalKind=kind;keys.clear();mouse.down=false;$('#close-modal').focus();}
function closeModal(){if(modalKind==='lobby'&&mode==='lobby'){leaveMatch();return;}$('#modal-backdrop').classList.add('hidden');modalKind='';keys.clear();}
$('#close-modal').addEventListener('click',()=>{if(modalKind==='result'){leaveMatch();return;}closeModal();});
$('#modal-backdrop').addEventListener('click',e=>{if(e.target===$('#modal-backdrop')&&!['lobby','result'].includes(modalKind))closeModal();});
function rooms(watch=false){
  modal(`<div class="overline">MULTIPLAYER / PRIVATE ROOM</div><h2 id="modal-title">Satu room. Dua tim.</h2><p class="intro">Ajak hingga 10 teman. Bagikan kode room dan bergabung ke server yang sama. Tim dibagi otomatis, maksimal 5 operator per tim.</p><label for="operator-name">NAMA OPERATOR</label><input id="operator-name" type="text" maxlength="16" value="${esc(name)}" placeholder="Nama kamu"><div class="room-actions"><div><h3>Buat arena</h3><p>Jadilah host dan atur waktu mulai.</p><button id="create-room" class="button primary">BUAT ROOM <span>↗</span></button></div><div><h3>Gabung atau menonton</h3><input id="join-code" type="text" maxlength="6" placeholder="KODE ROOM" autocomplete="off"><button id="join-room" class="button secondary">GABUNG ROOM <span>→</span></button><button id="watch-room" class="button secondary">◉ TONTON SAJA</button><p>Maks. 20 penonton, terpisah dari 10 pemain.</p></div></div><p id="room-network-note" class="intro" style="font-size:10px">${online?'Server terhubung · WebSocket real time · 30 tick/s':'Server belum terhubung. Jalankan npm start lalu buka http://localhost:7860. Mode latihan tetap tersedia.'}</p>`,'rooms');
  const join=(type)=>{if(!online){toast('Server belum aktif. Jalankan npm start untuk multiplayer.');return;}name=$('#operator-name').value.trim()||'Operator';try{localStorage.setItem('deadlock-name',name);}catch{}const code=$('#join-code').value.trim();if(type!=='create'&&!/^[a-f0-9]{6}$/i.test(code)){toast('Masukkan kode room 6 karakter.');return;}send({type,name,role,code,proto:2});};
  $('#create-room').onclick=()=>join('create');$('#join-room').onclick=()=>join('join');$('#watch-room').onclick=()=>join('spectate');$('#join-code').onkeydown=e=>{if(e.key==='Enter')join(watch?'spectate':'join');};
  const invite=new URLSearchParams(location.search).get('room');if(invite)$('#join-code').value=invite.toUpperCase();if(watch){$('#modal-title').textContent='Saksikan perang kernel.';$('#watch-room').classList.replace('secondary','primary');$('#join-code').focus();}
}
$('#open-rooms').onclick=()=>rooms();$('#open-watch').onclick=()=>rooms(true);
function lobby(){modal(`<div class="overline">LOBBY / KERNEL WARS</div><h2 id="modal-title">${spectating?'Menunggu pertandingan.':'Siapkan pasukanmu.'}</h2><div class="room-code-row"><span class="room-code">${esc(roomCode)}</span><button id="copy-room" class="button secondary" style="margin:0">SALIN LINK</button></div><p class="intro">Bagikan undangan. Pemain yang menyusul akan menggantikan bot di timnya.${["localhost","127.0.0.1"].includes(location.hostname)?"<br>Untuk perangkat lain, buka alamat IP LAN komputer server dengan port 7860 sebelum menyalin link.":""}</p><div class="teams-grid"><div class="lobby-team"><h3 class="cyan">SYNCHRON <span id="count-a">0/5</span></h3><div id="roster-a"></div></div><div class="lobby-team"><h3 class="coral">SYNTAX <span id="count-b">0/5</span></h3><div id="roster-b"></div></div></div><label class="checkbox-label"><input type="checkbox" id="fill-bots" checked> Isi slot kosong dengan bot</label><button id="start-match" class="button primary">MULAI PERTEMPURAN <span>→</span></button><p id="host-note" class="intro"></p><p id="lobby-viewers" class="intro"></p>`,'lobby');
  $('#copy-room').onclick=async()=>{const url=new URL(location.href);url.searchParams.set('room',roomCode);if(spectating)url.searchParams.set('watch','1');else url.searchParams.delete('watch');try{await navigator.clipboard.writeText(url.href);toast('Link undangan disalin.');}catch{toast(`Kode room: ${roomCode} — bagikan alamat server dan kode ini.`);}};
  $('#start-match').onclick=()=>send({type:'start',bots:$('#fill-bots').checked});
}
function lobbyUpdate(){if(modalKind!=='lobby')return;$('#lobby-viewers').textContent=`◉ ${viewerCount}/20 penonton · ${spectating?'Kamu hanya menonton. Slot pemain tidak berkurang.':'Penonton dapat masuk dengan kode room yang sama.'}`;const signature=state.players.map(p=>p.id).join()+hostId;if(signature===lastRoster)return;lastRoster=signature;for(let t=0;t<2;t++){const list=state.players.filter(p=>p.team===t);$(`#count-${t?'b':'a'}`).textContent=`${list.length}/5`;$(`#roster-${t?'b':'a'}`).innerHTML=Array.from({length:5},(_,i)=>list[i]?`<div class="lobby-player">${esc(list[i].name)}${list[i].id===myId?' •':''}<span>${CLASSES[list[i].role].name.toUpperCase()}</span></div>`:'<div class="lobby-player empty">Menunggu operator…<span>OPEN SLOT</span></div>').join('');}const host=!spectating&&hostId===myId;$('#start-match').disabled=!host;$('#fill-bots').disabled=!host;$('#start-match').classList.toggle('hidden',spectating);$('.checkbox-label').classList.toggle('hidden',spectating);$('#host-note').textContent=host?'Kamu adalah host. Mulai saat tim siap.':'Menunggu host memulai pertandingan.';}
function beginMatch(nextMode){predictor.reset();gate.reset();mode=nextMode;resultsShown=false;lastFeed='';lastSound=0;$('#modal-backdrop').classList.add('hidden');modalKind='';$('#menu').classList.add('hidden');$('#hud').classList.remove('hidden');document.body.classList.add('in-game');arena?.setMode(false);if(spectating)watchPlayer('');document.body.classList.toggle('spectating',spectating);$('#spectator-bar').classList.toggle('hidden',!spectating);keys.clear();pending={};touch={x:0,z:0,fire:false};arena&&(arena.eventId=0);$('#match-mode').textContent=nextMode==='local'?'PRACTICE · 5V5':`ROOM ${roomCode} · ${spectating?'PENONTON':'5V5'}`;toast(spectating?'Pilih seluruh arena atau ikuti operator. Kamu hanya menonton.':'Kunci 2 resource dengan E, lalu kembali ke core timmu dan tekan E.');}
$('#play-practice').onclick=()=>{if(!arena){toast('WebGL diperlukan. Aktifkan akselerasi grafis browser.');return;}spectating=false;viewerCount=0;localGame=new Game();myId='you';localGame.addPlayer(myId,name,role,0);localGame.start(true);state=localGame.snapshot();beginMatch('local');};
function leaveMatch(notify=true){saveSession(null);buffer.clear();predictor.reset();gate.reset();eventLog=[];roster=[];rosterV=-1;$('#connection-banner').classList.add('hidden');if(notify&&(mode==='online'||mode==='lobby'))send({type:'leave'});localGame=null;myId=null;state=null;mode='menu';roomCode='';resultsShown=false;$('#modal-backdrop').classList.add('hidden');modalKind='';$('#hud').classList.add('hidden');$('#menu').classList.remove('hidden');document.body.classList.remove('in-game','spectating');spectating=false;followId='';viewerCount=0;arena?.setMode(true);keys.clear();mouse.down=false;}
$('#leave-game').onclick=()=>{modal(`<div class="overline">MATCH IN PROGRESS</div><h2 id="modal-title">Keluar dari arena?</h2><p class="intro">${spectating?'Kamu akan keluar dari mode penonton.':'Resource yang kamu pegang akan dilepas.'} Pertandingan pemain lain tetap berjalan.</p><button id="confirm-leave" class="button primary">KELUAR</button> <button id="cancel-leave" class="button secondary">LANJUT MAIN</button>`,'leave');$('#confirm-leave').onclick=()=>leaveMatch();$('#cancel-leave').onclick=closeModal;};
for(const button of document.querySelectorAll('[data-role]'))button.onclick=()=>{role=button.dataset.role;document.querySelectorAll('[data-role]').forEach(b=>{b.classList.toggle('selected',b===button);b.querySelector('.role-select').textContent=b===button?'✓':'＋';});sound('lock');};
function guide(){modal(`<div class="overline">FIELD MANUAL / HOW TO PLAY</div><h2 id="modal-title">Aksi dulu. Strategi selalu.</h2><p class="intro">Pertandingan selalu berlangsung 6 menit penuh. Skor tertinggi saat timer habis menang; 100 poin tidak mengakhiri match. Menit terakhir: seluruh throughput ×2. Mati hanya respawn, bukan keluar.</p><div class="instruction-grid"><div class="instruction"><b>01 / ACQUIRE</b><h3>Rebut dua terminal</h3><p>Dekati CPU, RAM, I/O, atau GPU. Tekan E untuk mengambil lock. Resource tetap di terminal, tetapi akses eksklusifnya menjadi milikmu.</p></div><div class="instruction"><b>02 / EXECUTE</b><h3>Kembali ke core</h3><p>Bawa 2 lock berbeda ke core timmu dan tekan E. Proses selesai, kedua lock dilepas, dan tim mendapat 20 throughput.</p></div><div class="instruction"><b>03 / DISRUPT</b><h3>Hentikan lawan</h3><p>Arahkan mouse dan tahan klik atau F untuk menembak. Gunakan cover dan dash. Proses yang kalah respawn 5 detik kemudian.</p></div><div class="instruction"><b>04 / RECOVER</b><h3>Putus circular wait</h3><p>Menunggu lock membuatmu berhenti. Tekan R untuk rollback: semua lock dilepas dengan biaya 15 HP. Engineer bisa memulihkan tim di dekatnya.</p></div></div><p class="intel-note"><b>UPLINK:</b> zona tengah aktif 30 detik setiap 75 detik, mulai detik ke-35. Berdiri di dalam lingkaran untuk merebutnya: 6 detik solo, 3 detik dengan rekan. Bertahan di zona menghasilkan +4 setiap 5 detik; kedua tim hadir membuat perebutan dan poin berhenti. Pemain yang menunggu lock tidak bisa merebut zona.<br><b>MAIN KOMPAK:</b> Sentinel melindungi rekan sekitar selama 2 detik. Engineer melakukan recovery dan memulihkan 30 HP rekan dalam radius 9. Pengiriman 2 lock tetap sumber poin terbesar. Uplink adalah bonus arena, terpisah dari model lock OS.</p><div class="keys-table"><span><kbd>WASD / PANAH</kbd> Bergerak</span><span><kbd>MOUSE + KLIK / F</kbd> Tembak</span><span><kbd>E</kbd> Ambil / request / kirim</span><span><kbd>SPACE</kbd> Dash · cooldown 4s</span><span><kbd>SHIFT</kbd> Skill operator</span><span><kbd>R</kbd> Rollback proses</span><span><kbd>G</kbd> Graf ketergantungan</span><span><kbd>TAB</kbd> Scoreboard</span></div><p class="intel-note">Ponsel: joystick kiri untuk bergerak, FIRE menargetkan lawan terdekat. Gunakan tombol E, SKILL, DASH dan ROLLBACK di layar. Arena 84 × 56 memiliki jalur samping dan 12 cover. Mode penonton: masukkan kode room melalui Tonton Pertandingan, pilih seluruh arena atau ikuti operator, lalu atur zoom. Pertandingan terus berjalan saat panduan terbuka.</p>`,'guide');}
function intel(){modal(`<div class="overline">OPERATING SYSTEMS / LEARN THROUGH PLAY</div><h2 id="modal-title">Deadlock bukan sekadar berhenti.</h2><p class="intro">Setiap operator adalah sebuah proses. Empat terminal adalah resource dengan satu instance per jenis. Graf di arena menampilkan siapa menunggu siapa.</p><div class="instruction-grid"><div class="instruction"><b>01 / MUTUAL EXCLUSION</b><h3>Satu resource, satu pemilik</h3><p>Dua operator tidak dapat memegang CPU yang sama. Terminal berubah warna mengikuti tim pemilik lock.</p></div><div class="instruction"><b>02 / HOLD & WAIT</b><h3>Memegang sambil menunggu</h3><p>Kamu memegang CPU dan meminta RAM yang telah dikunci operator lain. CPU tetap menjadi milikmu saat kamu menunggu.</p></div><div class="instruction"><b>03 / NO PREEMPTION</b><h3>Lock tidak bisa dicuri</h3><p>Permintaan tidak merampas resource pemilik. Lock dilepas ketika proses selesai, melakukan rollback, atau dihentikan dalam pertempuran.</p></div><div class="instruction"><b>04 / CIRCULAR WAIT</b><h3>Siklus saling menunggu</h3><p>A memegang CPU dan menunggu RAM milik B. B menunggu CPU milik A. Keduanya terkunci; graf menandai siklus dengan warna merah.</p></div></div><p class="intel-note"><b>Pencegahan:</b> sepakati urutan CPU → RAM → I/O → GPU; jangan meminta resource berurutan lebih rendah saat memegang yang lebih tinggi. <b>Pemulihan:</b> rollback satu proses dalam siklus. Menunggu tanpa siklus belum tentu deadlock. Engineer melakukan rollback kooperatif, bukan mencuri lock.</p><p class="intro" style="font-size:10px">Model single-instance, deteksi melalui wait-for graph. <a href="https://www.cs.uic.edu/~jbell/CourseNotes/OperatingSystems/7_Deadlocks.html" target="_blank" rel="noreferrer" style="color:var(--lime)">Referensi materi: UIC Operating Systems ↗</a></p>`,'intel');}
for(const b of document.querySelectorAll('[data-nav]'))b.onclick=()=>{if(b.dataset.nav==='guide')guide();else if(b.dataset.nav==='intel')intel();else window.scrollTo({top:0,behavior:'smooth'});};
function table(){return `<table class="score-table"><thead><tr><th>OPERATOR</th><th>ELIM</th><th>KIRIM</th><th>RECOVERY</th></tr></thead><tbody>${[...state.players].sort((a,b)=>a.team-b.team||b.deliveries-a.deliveries).map(p=>`<tr><td class="${p.team?'coral':'cyan'}">${esc(p.name)} ${p.disconnected?'<small>RECONNECT</small>':p.bot?'<small>BOT</small>':''}${p.id===myId?' •':''}</td><td>${p.kills}</td><td>${p.deliveries}</td><td>${p.recoveries}</td></tr>`).join('')}</tbody></table>`;}
function scoreboard(){if(!state||mode==='menu')return;modal(`<div class="overline">LIVE MATCH / ${esc(roomCode||'PRACTICE')}</div><h2 id="modal-title">SYNCHRON ${state.scores[0]} : ${state.scores[1]} SYNTAX</h2>${table()}<p class="intro">Kirim 2 resource = 20 throughput. Uplink = 4 poin / 5 detik. Menit terakhir ×2. Pertandingan tetap berjalan.</p>`,'score');}
function results(){resultsShown=true;const winner=state.winner<0?'SYSTEM STALEMATE':`${state.winner?'SYNTAX':'SYNCHRON'} VICTORY`;modal(`<div class="overline">MATCH COMPLETE / PROCESS REPORT</div><h2 id="modal-title">${winner}</h2><p class="intro">Waktu pertandingan habis · 6 menit penuh.<br>Throughput akhir: ${state.scores[0]} — ${state.scores[1]}</p><div class="result-stats"><div><b>${state.stats.deadlocks}</b>SIKLUS DEADLOCK</div><div><b>${state.stats.recoveries}</b>RECOVERY</div><div><b>${state.stats.deliveries}</b>PROSES SELESAI</div></div>${table()}<p class="intel-note">${state.stats.deadlocks?'Siklus ketergantungan sempat menghentikan proses. Rollback melepaskan lock dan membuka jalur eksekusi kembali.':'Tim menjaga aliran resource tanpa circular wait. Koordinasi urutan pengambilan membantu mencegah deadlock.'}</p><button id="rematch" class="button primary">MAIN LAGI · ROOM YANG SAMA</button><p id="rematch-note" class="intro"></p><button id="return-home" class="button primary">KEMBALI KE MARKAS <span>→</span></button>`,'result');$('#return-home').onclick=()=>leaveMatch();$('#rematch').onclick=()=>{if(mode==='local'){localGame.rematch();localGame.start(true);state=localGame.snapshot();beginMatch('local');}else send({type:'rematch'});};updateRematchButton();sound('score');}
function updateRematchButton(){const button=$('#rematch');if(!button)return;const can=mode==='local'||(!spectating&&hostId===myId);button.disabled=!can||mode==='online'&&!online;button.textContent=mode==='local'?'MAIN LAGI':'REMATCH · KEMBALI KE LOBBY';$('#rematch-note').textContent=can?'Tim tetap sama. Semua skor, resource, dan timer direset.':'Menunggu host memulai rematch. Kamu tetap di room yang sama.';}
function toggleGraph(){$('#graph-panel').classList.toggle('hidden');}
$('#game-help').onclick=guide;$('#toggle-graph').onclick=toggleGraph;$('#rollback-button').onclick=$('#rollback-alert').onclick=()=>pending.rollback=true;
window.addEventListener('keydown',e=>{
  if(e.target.matches('input,select'))return;
  if(e.key==='Escape'){if(modalKind==='result')leaveMatch();else if(modalKind)closeModal();else if(mode==='local'||mode==='online')$('#leave-game').click();return;}
  if(!['local','online'].includes(mode))return;
  if(['Tab',' ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))e.preventDefault();
  if(modalKind){if(e.key==='Tab')closeModal();return;}
  keys.add(e.code);
  if(!e.repeat){const map=spectating?{}:{KeyE:'interact',KeyR:'rollback',ShiftLeft:'skill',ShiftRight:'skill',Space:'dash'};if(map[e.code])pending[map[e.code]]=true;if(e.code==='KeyG')toggleGraph();if(e.code==='KeyH')guide();if(e.key==='Tab')scoreboard();}
});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();mouse.down=false;touch={x:0,z:0,fire:false};});
window.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'){mouse.x=e.clientX;mouse.y=e.clientY;mouse.moved=true;}});
$('#scene').addEventListener('pointerdown',e=>{if(e.button===0&&e.pointerType==='mouse')mouse.down=true;});
window.addEventListener('pointerup',()=>mouse.down=false);
for(const b of document.querySelectorAll('[data-touch]')){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);if(b.dataset.touch==='fire')touch.fire=true;else pending[b.dataset.touch]=true;};b.onpointerup=b.onpointercancel=()=>{if(b.dataset.touch==='fire')touch.fire=false;};}
const stick=$('#joystick');stick.onpointerdown=e=>{stick.setPointerCapture(e.pointerId);updateStick(e);};stick.onpointermove=e=>{if(stick.hasPointerCapture(e.pointerId))updateStick(e);};stick.onpointerup=stick.onpointercancel=()=>{touch.x=touch.z=0;stick.firstElementChild.style.transform='';};
function updateStick(e){const r=stick.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,y=e.clientY-r.top-r.height/2,len=Math.max(35,Math.hypot(x,y));touch.x=x/len;touch.z=y/len;stick.firstElementChild.style.transform=`translate(${touch.x*32}px,${touch.z*32}px)`;}
function ownPlayer(){const p=state?.players.find(p=>p.id===myId);if(!p||mode!=='online'||!predictor.ready)return p;return {...p,x:predictor.m.x,z:predictor.m.z};}
function controls(){if(spectating)return {};const p=ownPlayer();if(!p)return{};let angle=p.angle;
  if(mouse.moved&&arena)angle=arena.aimAt(mouse.x,mouse.y,p);
  else {const enemy=state.players.filter(e=>e.team!==p.team&&!e.respawn).sort((a,b)=>distance(p,a)-distance(p,b))[0];if(enemy)angle=Math.atan2(enemy.x-p.x,enemy.z-p.z);}
  if(modalKind||mode==='online'&&!online)return{x:0,z:0,angle,fire:false};
  const input={x:(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+touch.x,
    z:(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-(keys.has('KeyW')||keys.has('ArrowUp')?1:0)+touch.z,angle,fire:mouse.down||keys.has('KeyF')||touch.fire,...pending};pending={};return input;
}
function updateHud(){if(!state)return;const p=spectating?null:state.players.find(p=>p.id===myId);
  $('#viewer-count').textContent=viewerCount;
  $('#timer').textContent=`${Math.floor(Math.ceil(state.time)/60).toString().padStart(2,'0')}:${(Math.ceil(state.time)%60).toString().padStart(2,'0')}`;
  for(let t=0;t<2;t++){const side=t?'b':'a';$(`#score-${side}`).textContent=String(state.scores[t]).padStart(2,'0');$(`#score-bar-${side}`).style.width=`${state.scores[t]/Math.max(1,state.scores[0]+state.scores[1])*100}%`;}
  $('#match-rule').textContent=state.blitz?'FINAL OVERCLOCK · POIN ×2':'6 MENIT PENUH';
  $('.match-clock').classList.toggle('blitz',!!state.blitz);
  const u=state.uplink;
  if(u){$('#uplink-status').textContent=u.active?(u.contested?'DIPEREBUTKAN':u.owner===null?'REBUT ZONA TENGAH':`${u.owner?'SYNTAX':'SYNCHRON'} MENGUASAI`):'UPLINK SEGERA AKTIF';$('#uplink-time').textContent=`${Math.ceil(u.next)}s`;$('#uplink-detail').textContent=u.active?(u.contested?'Singkirkan lawan untuk melanjutkan':`Bertahan di lingkaran · +${state.blitz?8:4} / 5s`):'Siapkan tim menuju tengah';$('#uplink-fill').style.width=`${Math.abs(u.progress)*100}%`;$('#uplink-fill').style.background=u.progress>0?'var(--coral)':'var(--cyan)';$('#uplink-panel').classList.toggle('active',u.active);}
  if(p){
  $('#player-name').textContent=p.name.toUpperCase();$('#player-name').style.color=p.team?'var(--coral)':'var(--cyan)';$('#health-value').textContent=`${Math.ceil(p.hp)} / ${p.maxHp}`;$('#health-bar').style.width=`${p.hp/p.maxHp*100}%`;$('#held-info').textContent=`LOCKS: ${p.held[0]||'EMPTY'} / ${p.held[1]||'EMPTY'}`;
  $('.player-avatar').textContent={runner:'ϟ',sentinel:'⬡',engineer:'✣'}[p.role];
  for(const [id,cd,label]of [['dash',p.dashCd,'DASH'],['skill',p.skillCd,CLASSES[p.role].skill.toUpperCase()]]){const el=$(`#ability-${id}`);el.querySelector('span').textContent=label;el.querySelector('strong').textContent=cd>0?`${cd.toFixed(1)}s`:'READY';el.classList.toggle('cooling',cd>0);}
  }
  $('#latency').innerHTML=mode==='local'?'LOCAL<br><small>30 TICK</small>':online?`${ping} MS<br><small>${telemetry.read(performance.now()).downKiBps.toFixed(0)} KB/S ↓</small>`:'OFFLINE<br><small>RECONNECT</small>';
  $('#deadlock-alert').classList.toggle('hidden',!p?.deadlocked);
  $('#respawn-overlay').classList.toggle('hidden',!p?.respawn);$('#respawn-count').textContent=Math.ceil(p?.respawn||0);
  $('#resource-list').innerHTML=state.resources.map(r=>{const owner=state.players.find(q=>q.id===r.owner);return `<div class="resource-row"><i style="background:${r.color}"></i><span>${r.id}</span><span style="color:${owner?.id===myId?'var(--lime)':''}">${owner?esc(owner.id===myId?'YOUR LOCK':owner.name):'AVAILABLE'}</span></div>`;}).join('');
  if(p){
  let title='Kunci 2 resource berbeda',text='Dekati terminal lalu tekan E. Bawa keduanya ke core timmu.';
  if(p.waiting){title=p.deadlocked?'Circular wait terdeteksi':`Menunggu ${p.waiting}`;text='Proses berhenti menunggu lock. R: rollback dan lepas semua lock (−15 HP).';}
  else if(p.held.length>=2){title='Kembali ke core timmu';text=`Tekan E di core ${p.team?'SYNTAX (kanan)':'SYNCHRON (kiri)'} untuk +${state.blitz?40:20} throughput.`;}
  $('#objective-title').textContent=title;$('#objective-text').textContent=text;
  const base=BASES[p.team],near=state.resources.filter(r=>!p.held.includes(r.id)).sort((a,b)=>distance(a,p)-distance(b,p))[0];let prompt='';
  if(!p.respawn&&!p.waiting){if(p.held.length>=2&&distance(p,base)<4)prompt=`[ E ] EKSEKUSI PROSES · +${state.blitz?40:20} THROUGHPUT`;else if(p.held.length<2&&near&&distance(near,p)<3.8)prompt=`[ E ] ${near.owner?'REQUEST':'KUNCI'} ${near.id}${near.owner?' · RESOURCE SEDANG DIPEGANG':''}`;}
  $('#interact-prompt').textContent=prompt;$('#interact-prompt').classList.toggle('hidden',!prompt);
  }else{updateSpectator();$('#objective-title').textContent='Pantau aliran resource';$('#objective-text').textContent='Skor, pemilik lock, dan graf ketergantungan diperbarui langsung.';$('#interact-prompt').classList.add('hidden');}
  const feed=state.events.slice(-4).map(e=>e.id).join();if(feed!==lastFeed){lastFeed=feed;$('#event-feed').innerHTML=state.events.slice(-4).reverse().map(e=>`<div class="feed-line ${e.type}">${esc(e.text)}</div>`).join('');const latest=state.events.at(-1);if(latest&&latest.id!==lastSound){lastSound=latest.id;sound(latest.type);}}
  drawMap(p);if(!$('#graph-panel').classList.contains('hidden'))drawGraph();
  if(state.phase==='finished'&&!resultsShown)results();
}
function updateSpectator(){
  const roster=state.players.map(p=>p.id+':'+p.name).join('|');
  if(roster!==watchRoster){watchRoster=roster;$('#watch-player').innerHTML='<option value="">Pilih operator</option>'+state.players.map(p=>`<option value="${esc(p.id)}">${p.team?'SYNTAX':'SYNCHRON'} · ${esc(p.name)}</option>`).join('');if(followId&&!state.players.some(p=>p.id===followId))watchPlayer('');$('#watch-player').value=followId;}
  const focused=state.players.find(p=>p.id===followId);
  $('#watch-details').textContent=focused?`${focused.name} · ${Math.ceil(focused.hp)}/${focused.maxHp} HP · ${focused.respawn?'RESPAWN':focused.deadlocked?'DEADLOCK':focused.waiting?'WAITING':'ACTIVE'}`:'Seluruh arena · Kedua tim terlihat';
}
function watchPlayer(id){followId=id;$('#watch-player').value=id;$('#watch-overview').classList.toggle('selected',!id);arena?.setCamera(id?'follow':'overview');}
$('#watch-player').onchange=e=>watchPlayer(e.target.value);
$('#watch-overview').onclick=()=>watchPlayer('');
function cycleWatch(step){if(!state?.players.length)return;const at=state.players.findIndex(p=>p.id===followId);watchPlayer(state.players[(at+step+state.players.length)%state.players.length].id);}
$('#watch-previous').onclick=()=>cycleWatch(-1);$('#watch-next').onclick=()=>cycleWatch(1);
for(const [id,delta] of [['watch-zoom-in',.15],['watch-zoom-out',-.15]])$('#'+id).onclick=()=>{if(!followId)cycleWatch(1);arena?.setCamera('follow',(arena?.zoom||1)+delta);};
$('#watch-score').onclick=scoreboard;
function drawMap(me){const c=$('#minimap'),ctx=c.getContext('2d'),sx=x=>(x+ARENA.width/2+1)/(ARENA.width+2)*180,sy=z=>(z+ARENA.depth/2+1)/(ARENA.depth+2)*126;ctx.clearRect(0,0,180,126);ctx.strokeStyle='#57796a';ctx.strokeRect(3,3,174,120);for(const w of WALLS){ctx.fillStyle='#4c6763';ctx.fillRect(sx(w.x-w.w/2),sy(w.z-w.d/2),w.w/(ARENA.width+2)*180,w.d/(ARENA.depth+2)*126);}for(const r of state.resources){ctx.fillStyle=r.color;ctx.fillRect(sx(r.x)-3,sy(r.z)-3,6,6);}if(state.uplink?.active){ctx.strokeStyle=state.uplink.contested?'#f9bd69':state.uplink.owner===1?'#fb8377':'#71ded2';ctx.beginPath();ctx.arc(sx(0),sy(0),8,0,Math.PI*2);ctx.stroke();}for(const p of state.players){if(p.respawn||p.disconnected)continue;ctx.fillStyle=p.id===(me?.id||followId)?'#d6f56f':p.team?'#fb8377':'#71ded2';ctx.beginPath();ctx.arc(sx(p.x),sy(p.z),p.id===(me?.id||followId)?3.5:2,0,Math.PI*2);ctx.fill();}for(const team of [0,1]){ctx.strokeStyle=team?'#fb8377':'#71ded2';ctx.beginPath();ctx.arc(sx(BASES[team].x),sy(0),6,0,Math.PI*2);ctx.stroke();}}
function drawGraph(){const list=state.players,positions=new Map(list.map((p,i)=>[p.id,{x:150+Math.cos(i/list.length*Math.PI*2-Math.PI/2)*112,y:94+Math.sin(i/list.length*Math.PI*2-Math.PI/2)*66}]));let svg='<defs><marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#f9b779"/></marker></defs>';let edges=0;for(const p of list){const owner=state.resources.find(r=>r.id===p.waiting)?.owner;if(owner&&positions.has(owner)){const a=positions.get(p.id),b=positions.get(owner);svg+=`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${p.deadlocked?'#fb8377':'#f9b779'}" stroke-width="2" marker-end="url(#arrow)"/>`;edges++;}}
  for(const p of list){const pos=positions.get(p.id);svg+=`<circle cx="${pos.x}" cy="${pos.y}" r="10" fill="${p.deadlocked?'#fb8377':p.team?'#784841':'#315e56'}" stroke="${p.team?'#fb8377':'#71ded2'}"/><text x="${pos.x}" y="${pos.y+3}" text-anchor="middle" fill="#f0f5e7" font-size="7">${esc(p.name.slice(0,3))}</text><text x="${pos.x}" y="${pos.y+21}" text-anchor="middle" fill="#93a89b" font-size="7">${p.held.join('+')}</text>`;}
  $('#graph').innerHTML=svg;$('#graph-note').textContent=state.cycles.length?`${state.cycles.length} siklus deadlock. Panah: peminta → pemilik. R untuk memutus siklus.`:edges?`${edges} proses menunggu. Belum ada circular wait.`:'Tidak ada proses menunggu. Semua jalur eksekusi terbuka.';
}
// One fixed client tick online: predict locally, then send only if the input changed (or as a keep-alive).
function sendInput(){
  const input=controls(),me=state?.players.find(p=>p.id===myId);
  if(Number.isFinite(input.angle))aimAngle=input.angle;
  const seq=predictor.tick(input,me),out=gate.check(input);
  if(out&&seq!==null&&socket?.readyState===WebSocket.OPEN){const text=JSON.stringify({type:'input',seq,input:out});socket.send(text);telemetry.up(text.length,performance.now());}
}
// Remote players are interpolated ~2 ticks in the past; the local player is drawn at the predicted position.
function netView(now){
  const view=buffer.sample(now)||state;if(!view||spectating||!predictor.ready)return view;
  return {...view,players:view.players.map(p=>p.id===myId?{...p,x:predictor.m.x,z:predictor.m.z,angle:aimAngle}:p)};
}
function frame(now){const dt=Math.min((now-lastFrame)/1000,.1);lastFrame=now;accumulator+=dt;
  while(accumulator>=1/30){accumulator-=1/30;if(mode==='local'){localGame.input(myId,controls());localGame.update(1/30);state=localGame.snapshot();}else if(mode==='online'&&!spectating)sendInput();else if(mode!=='online'){demo.update(1/30);demoTime+=1/30;if(demo.phase==='finished'){demo.rematch();demo.start(true);}}}
  const renderState=mode==='online'?netView(now):mode==='local'?state:demo.snapshot();arena?.render(renderState,spectating?followId:myId,now/1000,dt);
  if(now-lastHud>100&&['local','online'].includes(mode)){updateHud();lastHud=now;}
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if(!resumeSession&&new URLSearchParams(location.search).has('room'))setTimeout(()=>rooms(new URLSearchParams(location.search).get('watch')==='1'),500);
initSidebar(()=>({...telemetry.read(performance.now()),ping,online,mode,spectating,delay:buffer.delay,jitter:buffer.jitter,pred:predictor.stats,rosterWaits,room:roomCode}));
