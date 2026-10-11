export const ARENA = {width: 84, depth: 56, duration: 360};
export const UPLINK = {x: 0, z: 0, radius: 4.5, cycle: 75, opens: 35, closes: 65, capture: 6, pulse: 5};
export const BASES = [{x:-36,z:0},{x:36,z:0}];
export const CLASSES = {
  runner: {name: 'Runner', speed: 9.5, hp: 100, cooldown: 5, skill: 'Overdrive'},
  sentinel: {name: 'Sentinel', speed: 7, hp: 150, cooldown: 12, skill: 'Firewall'},
  engineer: {name: 'Engineer', speed: 8, hp: 115, cooldown: 9, skill: 'Recovery pulse'},
};
export const NODES = [
  {id: 'CPU', x: -13, z: -11, color: '#f9bd69', label: 'PROCESSOR'},
  {id: 'RAM', x: 13, z: -11, color: '#b5a0ff', label: 'MEMORY'},
  {id: 'IO', x: 13, z: 11, color: '#6ce4d5', label: 'I/O DEVICE'},
  {id: 'GPU', x: -13, z: 11, color: '#f7879a', label: 'GRAPHICS'},
];
export const WALLS = [
  {x:-25,z:-11,w:4,d:9}, {x:25,z:11,w:4,d:9},
  {x:-25,z:11,w:4,d:9}, {x:25,z:-11,w:4,d:9},
  {x:0,z:-23,w:12,d:2}, {x:0,z:23,w:12,d:2},
  {x:-7,z:0,w:3,d:5}, {x:7,z:0,w:3,d:5},
  {x:-15,z:-22,w:6,d:2}, {x:15,z:22,w:6,d:2},
  {x:-15,z:22,w:6,d:2}, {x:15,z:-22,w:6,d:2},
];
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
// v1.3: movement is a pure function shared by the server (authority) and the client (prediction).
export function moveEntity(p, dx, dz) {
  const valid = (x,z) => !WALLS.some(w => Math.abs(x-w.x) < w.w/2+.65 && Math.abs(z-w.z) < w.d/2+.65);
  const x = clamp(p.x+dx, -ARENA.width/2+1,ARENA.width/2-1), z = clamp(p.z+dz,-ARENA.depth/2+1,ARENA.depth/2-1);
  if (valid(x,p.z)) p.x=x;
  if (valid(p.x,z)) p.z=z;
}
// One 1/30 s step of the movement-relevant part of Game.update() for a single player.
// m = {x,z,role,boost,dashCd,skillCd,waiting,canAct}; input = {x,z,dash,skill}.
export function stepMover(m, input, dt) {
  for (const k of ['skillCd','dashCd','boost']) m[k] = Math.max(0, m[k]-dt);
  if (!m.canAct) return m;
  if (input.skill && m.skillCd <= 0) {m.skillCd = CLASSES[m.role].cooldown; if (m.role === 'runner') m.boost = 2.5;}
  if (m.waiting) return m;
  const dx = clamp(Number(input.x)||0,-1,1), dz = clamp(Number(input.z)||0,-1,1), len = Math.max(1, Math.hypot(dx,dz));
  let speed = CLASSES[m.role].speed*(m.boost>0?1.6:1);
  if (input.dash && m.dashCd <= 0) {m.dashCd = 4; m.boost = .35; speed *= 3;}
  moveEntity(m, dx/len*speed*dt, dz/len*speed*dt);
  return m;
}
export function clearPath(a,b) {
  return !WALLS.some(w=>{
    let lo=0,hi=1;
    for(const [axis,size] of [['x','w'],['z','d']]){
      const min=w[axis]-w[size]/2-.8,max=w[axis]+w[size]/2+.8,delta=b[axis]-a[axis];
      if(Math.abs(delta)<1e-9){if(a[axis]<min||a[axis]>max)return false;}
      else{let t1=(min-a[axis])/delta,t2=(max-a[axis])/delta;if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2);if(lo>hi)return false;}
    }
    return true;
  });
}
const waypoints=WALLS.flatMap(w=>[-1,1].flatMap(sx=>[-1,1].map(sz=>({x:w.x+sx*(w.w/2+1.1),z:w.z+sz*(w.d/2+1.1)}))));
const routes=waypoints.map((a,i)=>waypoints.flatMap((b,j)=>i!==j&&clearPath(a,b)?[{to:j,cost:distance(a,b)}]:[]));
export function findPath(start,goal){
  if(clearPath(start,goal))return [{x:goal.x,z:goal.z}];
  const points=[...waypoints,goal],costs=points.map(p=>clearPath(start,p)?distance(start,p):Infinity),previous=points.map(()=>-1),done=new Set();
  while(done.size<points.length){
    let current=-1;for(let i=0;i<points.length;i++)if(!done.has(i)&&(current<0||costs[i]<costs[current]))current=i;
    if(current<0||!Number.isFinite(costs[current]))break;
    if(current===points.length-1){const path=[];for(let i=current;i>=0;i=previous[i])path.unshift({...points[i]});return path;}
    done.add(current);
    const edges=[...routes[current]];if(clearPath(points[current],goal))edges.push({to:points.length-1,cost:distance(points[current],goal)});
    for(const edge of edges)if(costs[current]+edge.cost<costs[edge.to]){costs[edge.to]=costs[current]+edge.cost;previous[edge.to]=current;}
  }
  return [];
}
export function detectCycles(players, resources) {
  const edge = new Map();
  for (const p of players) {
    const owner = resources.find(r => r.id === p.waiting)?.owner;
    if (owner && owner !== p.id) edge.set(p.id, owner);
  }
  const cycles = [], done = new Set();
  for (const id of edge.keys()) {
    const path = [], visited = new Map();
    let current = id;
    while (edge.has(current) && !done.has(current)) {
      if (visited.has(current)) { cycles.push(path.slice(visited.get(current))); break; }
      visited.set(current, path.length); path.push(current); current = edge.get(current);
    }
    path.forEach(n => done.add(n));
  }
  return cycles;
}
export class Game {
  constructor() {
    this.players = []; this.resources = NODES.map(n => ({...n, owner: null}));
    this.bullets = []; this.events = []; this.cycles = []; this.scores = [0, 0];
    this.time = ARENA.duration; this.phase = 'lobby'; this.tick = 0; this.serial = 0;
    this.stats = {deadlocks: 0, recoveries: 0, deliveries: 0}; this.previousCycles = '';
    this.uplink = {active:false, progress:0, owner:null, contested:false, pulse:0, next:UPLINK.opens};
    this.blitz = false;
  }
  event(text, type = 'info', position) {
    this.events.push({id: ++this.serial, text, type, ...(position ? {x:position.x,z:position.z} : {})});
    this.events = this.events.slice(-12);
  }
  addPlayer(id, name, role = 'runner', team, bot = false) {
    if (this.players.length >= 10) return null;
    if (!CLASSES[role]) role = 'runner';
    const counts = [0, 1].map(t => this.players.filter(p => p.team === t).length);
    if (team !== 0 && team !== 1) team = counts[0] <= counts[1] ? 0 : 1;
    if (counts[team] >= 5) return null;
    const p = {id, name: String(name || 'Operator').slice(0, 16), role, team, bot,
      x: BASES[team].x, z: (counts[team] - 2) * 2.5, angle: team ? -Math.PI/2 : Math.PI/2,
      hp: CLASSES[role].hp, maxHp: CLASSES[role].hp, held: [], waiting: null,
      deadlocked: false, kills: 0, deliveries: 0, recoveries: 0, respawn: 0, disconnected:false,
      shotCd: 0, skillCd: 0, dashCd: 0, shield: 0, boost: 0, aiTime: 0, input: {}};
    this.players.push(p); return p;
  }
  removePlayer(id) {
    const p = this.players.find(p => p.id === id);
    if (p) this.release(p);
    this.players = this.players.filter(p => p.id !== id);
  }
  fillBots() {
    const names = ['ATLAS', 'NOVA', 'VECTOR', 'ECHO', 'GHOST', 'AXIOM', 'PIXEL', 'FLUX', 'BYTE', 'ORBIT'];
    let n = 0;
    while (this.players.length < 10) {
      const id = `bot-${++this.serial}`;
      this.addPlayer(id, names[n % names.length], ['runner', 'sentinel', 'engineer'][n % 3], undefined, true); n++;
    }
  }
  start(bots = true) {
    if (this.phase !== 'lobby') return;
    if (bots) this.fillBots();
    this.phase = 'playing'; this.event('Kernel online. Kuasai resource. Lindungi core.', 'start');
  }
  rematch() {
    if (this.phase !== 'finished') return false;
    const humans=this.players.filter(p=>!p.bot).map(p=>({...p}));
    Object.assign(this,new Game());
    for(const p of humans){const next=this.addPlayer(p.id,p.name,p.role,p.team);next.disconnected=p.disconnected;}
    return true;
  }
  release(p) {
    this.resources.forEach(r => {if (r.owner === p.id) r.owner = null;});
    p.held = []; p.waiting = null; p.deadlocked = false;
  }
  rollback(p) {
    if (!p.held.length && !p.waiting) return;
    const recovered = p.deadlocked;
    this.release(p); p.hp = Math.max(1, p.hp - 15);
    if (recovered) {p.recoveries++; this.stats.recoveries++;}
    this.event(`${p.name} melakukan rollback · semua lock dilepas`, 'recovery', p);
  }
  interact(p) {
    if (p.respawn || p.disconnected || p.waiting || this.phase !== 'playing') return;
    const base = BASES[p.team];
    if (distance(p, base) < 4 && p.held.length >= 2) {
      const points=this.blitz?40:20;
      this.release(p); this.scores[p.team] += points; p.deliveries++; this.stats.deliveries++;
      p.hp = p.maxHp; this.event(`${p.name} mengeksekusi proses · +${points} throughput`, 'score', base); return;
    }
    const r = this.resources.filter(r => !p.held.includes(r.id)).sort((a,b) => distance(p,a)-distance(p,b))[0];
    if (!r || distance(p, r) > 3.8 || p.held.length >= 2) return;
    if (r.owner) {p.waiting = r.id; p.aiTime=0; this.event(`${p.name} menunggu ${r.id} · hold & wait`, 'wait', r);}
    else {r.owner = p.id; p.held.push(r.id); this.event(`${p.name} mengunci ${r.id}`, 'lock', r);}
  }
  skill(p) {
    if (p.skillCd > 0 || p.respawn || p.disconnected || this.phase!=='playing') return;
    p.skillCd = CLASSES[p.role].cooldown;
    if (p.role === 'runner') p.boost = 2.5;
    const allies=this.players.filter(a=>a.team===p.team&&!a.respawn&&!a.disconnected&&distance(a,p)<9);
    if (p.role === 'sentinel') {p.shield = 4;allies.forEach(a=>a.shield=Math.max(a.shield,2));}
    if (p.role === 'engineer') {
      // Cooperative recovery terminates/rolls back allied processes, never steals a lock.
      allies.filter(a => a.waiting || a.deadlocked).forEach(a => this.rollback(a));
      allies.forEach(a=>a.hp=Math.min(a.maxHp,a.hp+30));
    }
    this.event(`${p.name} · ${CLASSES[p.role].skill}`, 'skill', p);
  }
  input(id, input, seq) {
    const p = this.players.find(p => p.id === id);
    if (!p || p.bot || p.disconnected || this.phase !== 'playing') return;
    p.input = {x: clamp(Number(input.x) || 0, -1, 1), z: clamp(Number(input.z) || 0, -1, 1),
      angle: Number.isFinite(input.angle) ? input.angle : p.angle, fire: !!input.fire,
      interact: p.input.interact || !!input.interact, rollback: p.input.rollback || !!input.rollback,
      skill: p.input.skill || !!input.skill, dash: p.input.dash || !!input.dash};
    p.lastInput = this.tick;
    if (Number.isInteger(seq) && seq >= 0 && seq <= 0xFFFF) {p.inputSeq = seq; p.inputTick = this.tick;}
  }
  move(p, dx, dz) {moveEntity(p, dx, dz);}
  ai(p, dt) {
    p.aiTime += dt;
    const enemies = this.players.filter(e => e.team !== p.team && !e.respawn && !e.disconnected);
    const enemy = enemies.sort((a,b) => distance(a,p)-distance(b,p))[0];
    let goal;
    if (p.held.length >= 2) goal = BASES[p.team];
    else if (this.uplink.active && p.held.length===0 && this.players.filter(a=>a.team===p.team&&a.bot&&a.held.length===0).slice(0,2).includes(p)) {
      goal=UPLINK;
    } else {
      const heldNode = this.resources.find(r => p.held.includes(r.id));
      // Cross the contested center for the second lock instead of farming one side.
      const choices = this.resources.filter(r => !p.held.includes(r.id) && (!heldNode || Math.sign(r.x)!==Math.sign(heldNode.x)));
      goal = choices.sort((a,b) => (distance(a,p)+(a.owner ? 10:0))-(distance(b,p)+(b.owner ? 10:0)))[0];
    }
    let dx=0,dz=0;
    if (goal) {
      const targetKey=`${goal.x}:${goal.z}`;
      if(p.navGoal!==targetKey || !p.navPath?.length){p.navGoal=targetKey;p.navPath=findPath(p,goal);}
      while(p.navPath.length>1 && distance(p,p.navPath[0])<.8)p.navPath.shift();
      const waypoint=p.navPath[0]||goal;
      dx=waypoint.x-p.x;dz=waypoint.z-p.z;
    }
    const length=Math.hypot(dx,dz)||1;
    if (p.waiting && p.aiTime > (p.deadlocked ? 6:9)) {this.rollback(p); p.aiTime=0;}
    if (goal && goal!==UPLINK && distance(goal,p)<3.2) this.interact(p);
    return {x:dx/length,z:dz/length, angle:enemy ? Math.atan2(enemy.x-p.x,enemy.z-p.z) : p.angle,
      fire:enemy && distance(enemy,p)<16, skill:p.hp<p.maxHp*.55||(goal===UPLINK&&distance(p,UPLINK)<6), dash:false};
  }
  updateUplink(dt) {
    const u=this.uplink, clock=(ARENA.duration-this.time)%UPLINK.cycle;
    const active=clock>=UPLINK.opens&&clock<UPLINK.closes;
    u.next=active?UPLINK.closes-clock:clock<UPLINK.opens?UPLINK.opens-clock:UPLINK.cycle-clock+UPLINK.opens;
    if(active!==u.active){
      Object.assign(u,{active,progress:0,owner:null,contested:false,pulse:0});
      this.event(active?'UPLINK ONLINE · rebut dan pertahankan zona tengah!':'Uplink offline · kembali berburu resource.','uplink',UPLINK);
    }
    if(!active)return;
    const count=[0,1].map(t=>this.players.filter(p=>p.team===t&&!p.respawn&&!p.disconnected&&!p.waiting&&distance(p,UPLINK)<=UPLINK.radius).length);
    u.contested=count.every(n=>n>0);
    if(u.contested||!count.some(Boolean))return;
    const team=count[0]?0:1, direction=team===0?-1:1;
    u.progress=clamp(u.progress+direction*dt*Math.min(count[team],2)/UPLINK.capture,-1,1);
    if(u.owner!==null&&u.progress!==(u.owner===0?-1:1)){u.owner=null;u.pulse=0;}
    if(Math.abs(u.progress)>=1&&u.owner!==team){u.owner=team;u.pulse=0;this.event(`${team?'SYNTAX':'SYNCHRON'} menguasai uplink · pertahankan zona!`,'uplink',UPLINK);}
    if(u.owner===team){u.pulse+=dt;if(u.pulse>=UPLINK.pulse){u.pulse-=UPLINK.pulse;const points=this.blitz?8:4;this.scores[team]+=points;this.event(`Uplink ${team?'SYNTAX':'SYNCHRON'} · +${points} throughput`,'score',UPLINK);}}
  }
  update(dt) {
    if (this.phase !== 'playing') return;
    dt=Math.max(0,Math.min(Number(dt)||0,.1)); this.tick++; this.time=Math.max(0,this.time-dt);
    if(this.time<1e-6)this.time=0;
    if(this.time<=60&&!this.blitz){this.blitz=true;this.event('FINAL OVERCLOCK · semua throughput ×2 sampai waktu habis!','start');}
    for (const p of this.players) {
      if(p.disconnected)continue;
      for (const k of ['shotCd','skillCd','dashCd','shield','boost']) p[k]=Math.max(0,p[k]-dt);
      if (p.respawn>0) {
        p.respawn=Math.max(0,p.respawn-dt);
        if (!p.respawn) {p.hp=p.maxHp; p.navPath=[]; p.x=BASES[p.team].x; p.z=(this.players.indexOf(p)%5-2)*2; p.shield=2;}
        continue;
      }
      const input=p.bot?this.ai(p,dt):p.input;
      if (!p.bot && this.tick-(p.lastInput || 0)>15) {input.x=0;input.z=0;input.fire=false;}
      if (input.rollback) this.rollback(p);
      if (input.skill) this.skill(p);
      if (input.interact) this.interact(p);
      p.angle=input.angle ?? p.angle;
      if (!p.waiting) {
        let dx=input.x||0,dz=input.z||0,len=Math.max(1,Math.hypot(dx,dz));
        let speed=CLASSES[p.role].speed*(p.boost>0?1.6:1);
        if (input.dash && p.dashCd<=0) {p.dashCd=4; p.boost=.35; p.shield=.35; speed*=3;}
        this.move(p,dx/len*speed*dt,dz/len*speed*dt);
        if (input.fire && p.shotCd<=0) {
          p.shotCd=p.role==='sentinel'?.35:.27;
          this.bullets.push({id:++this.serial,owner:p.id,team:p.team,x:p.x+Math.sin(p.angle),z:p.z+Math.cos(p.angle),
            dx:Math.sin(p.angle)*30,dz:Math.cos(p.angle)*30,life:.75});
        }
      }
      if (!p.bot) {input.interact=false;input.rollback=false;input.skill=false;input.dash=false;}
      if (distance(p,BASES[p.team])<3) p.hp=Math.min(p.maxHp,p.hp+dt*10);
    }
    for (const r of this.resources) {
      if (!r.owner) {
        const waiting=this.players.find(p => p.waiting===r.id && !p.respawn && !p.disconnected);
        if (waiting) {r.owner=waiting.id;waiting.held.push(r.id);waiting.waiting=null;}
      }
    }
    const cycles=detectCycles(this.players,this.resources), key=JSON.stringify(cycles.map(c=>[...c].sort()).sort());
    this.players.forEach(p => p.deadlocked=cycles.some(c=>c.includes(p.id)));
    if (cycles.length && key!==this.previousCycles) {
      this.stats.deadlocks++; this.event('DEADLOCK · circular wait terdeteksi. Rollback untuk memutus siklus.', 'deadlock');
    }
    this.cycles=cycles; this.previousCycles=key;
    for (const b of this.bullets) {
      b.x+=b.dx*dt; b.z+=b.dz*dt; b.life-=dt;
      if (WALLS.some(w=>Math.abs(b.x-w.x)<w.w/2 && Math.abs(b.z-w.z)<w.d/2)) b.life=0;
      if (b.life<=0) continue;
      const hit=this.players.find(p=>p.team!==b.team && !p.respawn && !p.disconnected && distance(p,b)<1);
      if (hit) {
        b.life=0; if (hit.shield>0) continue; hit.hp-=13;
        if (hit.hp<=0) {
          const shooter=this.players.find(p=>p.id===b.owner); if (shooter) shooter.kills++;
          this.release(hit);hit.hp=0;hit.respawn=5;
          this.event(`${shooter?.name || 'Operator'} menghentikan proses ${hit.name}`, 'kill', hit);
        }
      }
    }
    this.bullets=this.bullets.filter(b=>b.life>0);
    this.updateUplink(dt);
    if (this.time<=0) {
      this.phase='finished';this.winner=this.scores[0]===this.scores[1]?-1:this.scores[0]>this.scores[1]?0:1;
      this.event('Match selesai. Lihat laporan proses.', 'finish');
    }
  }
  // Last client input sequence the server has applied for p (0xFFFF = none yet).
  // Unchanged inputs are not re-sent by v1.3 clients, so the server assumes the same input stays in force.
  ack(p) {return p.inputSeq === undefined ? 0xFFFF : (p.inputSeq + (this.tick - p.inputTick) - 1) & 0xFFFF;}
  snapshot() {
    return {players:this.players.map(({input,aiTime,lastInput,navGoal,navPath,inputSeq,inputTick,...p})=>p), resources:this.resources,
      bullets:this.bullets,events:this.events,cycles:this.cycles,scores:this.scores,time:this.time,
      phase:this.phase,tick:this.tick,stats:this.stats,winner:this.winner,uplink:this.uplink,blitz:this.blitz};
  }
}
