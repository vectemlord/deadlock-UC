import * as THREE from '../public/vendor/three.module.js';
import {ARENA,BASES,NODES,WALLS,UPLINK} from '../shared/game.js';
const COLORS=[0x66d9ca,0xf98278];
export class Arena {
  constructor(container) {
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x101719);
    this.scene.fog=new THREE.FogExp2(0x101719,.007);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.3;
    container.appendChild(this.renderer.domElement);
    this.camera=new THREE.OrthographicCamera(-40,40,25,-25,.1,300);
    this.scene.add(new THREE.HemisphereLight(0xd5efe8,0x263c42,2.5));
    const sun=new THREE.DirectionalLight(0xffe6bf,3.4);sun.position.set(-20,38,15);sun.castShadow=true;
    sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-65,right:65,top:60,bottom:-60,near:1,far:150});sun.shadow.bias=-.001;this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0x89c9ef,1.5);fill.position.set(25,18,-20);this.scene.add(fill);
    this.world=new THREE.Group();this.scene.add(this.world);this.avatars=new Map();this.projectiles=new Map();this.labels=new Map();this.rings=[];this.crystals=[];this.nodeGroups=new Map();this.fx=[];this.eventId=0;
    this.menu=true;this.cameraView='follow';this.zoom=1;this.cameraTarget=new THREE.Vector3();this.pointer=new THREE.Vector2();this.raycaster=new THREE.Raycaster();this.plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);this.aim=new THREE.Vector3();
    this.build();this.resize();window.addEventListener('resize',()=>this.resize());
  }
  material(color,emissive=false){return new THREE.MeshStandardMaterial({color,roughness:.75,metalness:.22,...(emissive?{emissive:color,emissiveIntensity:.6}:{})});}
  box(x,y,z,w,h,d,color,parent=this.world){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),this.material(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
  cylinder(x,y,z,r,h,color,sides=8,parent=this.world){const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,h,sides),this.material(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
  ring(x,y,z,r,color,parent=this.world){const mesh=new THREE.Mesh(new THREE.TorusGeometry(r,.065,6,64),new THREE.MeshBasicMaterial({color}));mesh.rotation.x=Math.PI/2;mesh.position.set(x,y,z);parent.add(mesh);return mesh;}
  line(points,color,opacity=.7){const geo=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p)));const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color,transparent:true,opacity}));this.world.add(line);return line;}
  label(text,color='#b2c5c2',scale=3.5){const c=document.createElement('canvas');let ctx=c.getContext('2d');ctx.font='600 36px monospace';c.width=Math.ceil(ctx.measureText(text).width)+24;c.height=72;ctx=c.getContext('2d');ctx.font='600 36px monospace';ctx.textAlign='center';ctx.shadowColor='#06151c';ctx.shadowBlur=7;ctx.fillStyle=color;ctx.fillText(text,c.width/2,48);const texture=new THREE.CanvasTexture(c);const s=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false}));const width=Math.max(scale,text.length*.48);s.scale.set(width,width*72/c.width,1);return s;}
  build(){
    const {width,depth}=ARENA,halfX=width/2,halfZ=depth/2;
    this.box(0,-1.1,0,width+2,2,depth+2,0x202d30);this.box(0,-.12,0,width,.3,depth,0x3e5051);
    this.box(0,-2.4,0,width-4,1,depth-4,0x111c22);
    for(let x=-halfX;x<=halfX;x+=2)this.line([[x,.045,-halfZ],[x,.045,halfZ]],0x6b8077,.20);
    for(let z=-halfZ;z<=halfZ;z+=2)this.line([[-halfX,.045,z],[halfX,.045,z]],0x6b8077,.20);
    for(const z of [-halfZ,halfZ]){this.box(0,.15,z,width+2,.3,.25,0x8b9990);this.box(0,-.5,z,width+1,.14,.08,0x899f73);}
    for(const x of [-halfX,halfX])this.box(x,.15,0,.25,.3,depth,0x8b9990);
    for(const z of [-3,3,-18,18]){this.line([[-halfX+2,.08,z],[halfX-2,.08,z]],0x829881,.55);for(let x=-halfX+3;x<halfX-2;x+=3)this.box(x,.05,z,.65,.02,.09,0xa6b38e);}
    for(const [text,z] of [['NORTH TRANSIT',-19],['SOUTH TRANSIT',19]]){const label=this.label(text,'#8fa99c',5);label.position.set(0,.12,z);this.world.add(label);}
    this.uplinkRing=this.ring(0,.10,0,UPLINK.radius,0x718679);this.uplinkBeam=new THREE.Mesh(new THREE.CylinderGeometry(UPLINK.radius,UPLINK.radius,3,48,1,true),new THREE.MeshBasicMaterial({color:0xd6f56f,transparent:true,opacity:.08,side:THREE.DoubleSide,depthWrite:false}));this.uplinkBeam.position.y=1.5;this.world.add(this.uplinkBeam);this.ring(0,.07,0,3.8,0x5f776c);
    const emblem=this.box(0,.06,0,3,.04,3,0x526a5c);emblem.rotation.y=Math.PI/4;
    const center=this.label('UPLINK','#d9e3bb',3.4);center.position.set(0,.15,0);center.material.rotation=0;this.world.add(center);
    for(const w of WALLS){
      this.box(w.x,1,w.z,w.w,2,w.d,0x51666b);this.box(w.x,2.07,w.z,w.w+.12,.16,w.d+.12,0x738582);
      this.box(w.x,1.35,w.z+w.d/2+.02,w.w*.65,.14,.06,0xacc5ac);
      for(let i=0;i<3;i++)this.box(w.x-w.w*.3+i*w.w*.3,2.2,w.z,.11,.12,w.d*.7,0x27393d);
    }
    // Small server racks beyond play bounds give the arena a data-centre silhouette.
    for(let i=0;i<21;i++){
      const x=-40+i*4,z=i%2?-30:30,h=1.3+(i%4)*.7;
      this.box(x,h/2,z,1.6,h,1.3,0x273a40);this.box(x,h+.1,z,1.7,.2,1.4,0x637c76);
      for(let k=0;k<3;k++)this.box(x,h*.35+k*.36,z+(z>0?-.67:.67),1.15,.09,.035,k===0?0xb6cf80:0x78a19a);
    }
    for(const n of NODES){
      const g=new THREE.Group();g.position.set(n.x,0,n.z);this.world.add(g);this.nodeGroups.set(n.id,g);
      this.cylinder(0,.2,0,2.3,.4,0x273a40,8,g);this.cylinder(0,.5,0,1.8,.24,0x788c81,8,g);
      this.cylinder(0,.87,0,1.15,.65,0x324a50,6,g);this.ring(0,.66,0,1.85,n.color,g);
      const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(.95),this.material(n.color,true));crystal.position.y=2.2;g.add(crystal);this.crystals.push(crystal);
      for(let a=0;a<4;a++){let t=a*Math.PI/2;this.box(Math.cos(t)*1.5,1.2,Math.sin(t)*1.5,.3,1.4,.3,0x839993,g);}
      const r=this.ring(0,.12,0,3.3,n.color,g);r.material.transparent=true;r.material.opacity=.27;this.rings.push(r);
      const label=this.label(n.id,n.color,2.7);label.position.set(0,3.7,0);g.add(label);
      const plate=this.label(n.label,'#afbeb0',3.1);plate.position.set(0,.3,2.6);g.add(plate);
      this.line([[n.x,.07,n.z],[n.x,.07,0],[BASES[n.x<0?0:1].x,.07,0]],n.color,.28);
    }
    for(let team=0;team<2;team++){
      const x=BASES[team].x,col=COLORS[team],g=new THREE.Group();g.position.x=x;this.world.add(g);
      this.cylinder(0,.15,0,3.5,.3,0x223b3d,12,g);this.ring(0,.32,0,3.3,col,g);this.ring(0,.34,0,2.7,col,g);
      this.cylinder(0,.55,0,1.8,.7,0x728782,6,g);this.cylinder(0,1.4,0,1.2,1.2,0x2f474f,6,g);
      const crystal=new THREE.Mesh(new THREE.OctahedronGeometry(1.4),this.material(col,true));crystal.position.y=3;g.add(crystal);this.crystals.push(crystal);
      for(let j=0;j<3;j++){const ring=this.ring(0,1.8+j*.65,0,1.6-j*.15,col,g);ring.rotation.x=.9;ring.rotation.y=j;this.rings.push(ring);}
      for(let k=0;k<3;k++){const a=k*Math.PI*2/3;this.box(Math.cos(a)*2,1.4,Math.sin(a)*2,.5,2.4,.5,0x516b70,g);}
      const label=this.label(team?'SYNTAX CORE':'SYNCHRON CORE',team?'#ffae94':'#8aeee1',5);label.position.set(0,5.5,0);g.add(label);
      const light=new THREE.PointLight(col,8,10,2);light.position.set(x,3,0);this.scene.add(light);
    }
    // Floating dust packets.
    const positions=new Float32Array(210*3);for(let i=0;i<210;i++){positions[i*3]=(Math.random()-.5)*(ARENA.width+20);positions[i*3+1]=Math.random()*14;positions[i*3+2]=(Math.random()-.5)*(ARENA.depth+20);}
    const dust=new THREE.BufferGeometry();dust.setAttribute('position',new THREE.BufferAttribute(positions,3));this.dust=new THREE.Points(dust,new THREE.PointsMaterial({color:0xb4d2b4,size:.065,transparent:true,opacity:.5}));this.scene.add(this.dust);
  }
  avatar(p){
    const g=new THREE.Group(),col=COLORS[p.team],dark=0x263a43;
    const base=this.cylinder(0,.09,0,.85,.08,col,24,g);base.material=this.material(col,true);
    const body=this.box(0,1.05,0,.78,.95,.53,col,g);body.rotation.z=.03;
    this.box(0,1.15,-.29,.54,.6,.18,dark,g);
    this.box(0,1.76,0,.67,.6,.61,0xb2c3b8,g);this.box(0,1.78,.33,.54,.22,.08,dark,g);this.box(0,1.79,.38,.42,.06,.03,col,g);
    const left=this.box(-.26,.37,0,.28,.6,.33,dark,g),right=this.box(.26,.37,0,.28,.6,.33,dark,g);
    this.box(-.53,1.2,0,.28,.55,.38,col,g);this.box(.53,1.2,.13,.28,.5,.4,col,g);
    this.box(.48,1.04,.6,.22,.24,.85,0x1a2c36,g);this.box(.48,1.05,1.03,.12,.13,.12,col,g);
    if(p.role==='sentinel')this.box(0,1.24,0,1.15,.26,.65,col,g);
    if(p.role==='engineer'){this.box(0,1.23,-.48,.55,.55,.25,0xd7d99d,g);this.box(-.4,2.06,0,.04,.4,.04,col,g);}
    const shield=new THREE.Mesh(new THREE.SphereGeometry(1.3,16,12),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.12,wireframe:true}));shield.position.y=1;g.add(shield);
    const label=this.label(p.name,p.team?'#f6baac':'#b8ece1',3.1);label.position.y=3;this.world.add(label);
    const ring=this.ring(0,.12,0,1.2,0xd6f56f,g);ring.visible=false;
    this.world.add(g);const model={g,left,right,label,shield,ring,lastX:p.x,lastZ:p.z};this.avatars.set(p.id,model);return model;
  }
  setMode(menu){this.menu=menu;this.cameraView='follow';this.zoom=1;this.cameraTarget.set(0,0,0);this.resize();}
  setCamera(view,zoom=this.zoom){this.cameraView=view;this.zoom=Math.max(.7,Math.min(1.5,zoom));this.resize();}
  resize(){
    const w=innerWidth,h=innerHeight;this.renderer.setSize(w,h);const ratio=w/h;
    let half=this.menu?42:this.cameraView==='overview'?Math.max(ARENA.depth*.6,ARENA.width*.58/ratio):21/this.zoom;
    if(!this.menu&&this.cameraView==='follow'&&ratio<1)half=18/ratio/this.zoom;
    this.camera.left=-half*ratio;this.camera.right=half*ratio;this.camera.top=half;this.camera.bottom=-half;
    if(this.menu){this.camera.position.set(52,66,62);this.camera.lookAt(0,0,0);this.camera.setViewOffset(w,h,-w*(ratio<1?.18:.23),-h*.03,w,h);}
    else{this.camera.position.set(0,64,42);this.camera.lookAt(0,0,0);this.camera.clearViewOffset();}
    this.camera.updateProjectionMatrix();
  }
  aimAt(clientX,clientY,p){this.pointer.set(clientX/innerWidth*2-1,-clientY/innerHeight*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);this.raycaster.ray.intersectPlane(this.plane,this.aim);return Math.atan2(this.aim.x-p.x,this.aim.z-p.z);}
  burst(x,z,color){
    for(let i=0;i<10;i++){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.16,.16,.16),new THREE.MeshBasicMaterial({color}));mesh.position.set(x,1,z);this.world.add(mesh);this.fx.push({mesh,v:new THREE.Vector3((Math.random()-.5)*8,Math.random()*6,(Math.random()-.5)*8),life:1});}
  }
  render(state,myId,time,dt){
    if(!this.menu){
      const me=this.cameraView==='follow'?state?.players.find(p=>p.id===myId):null;
      const target=me?new THREE.Vector3(me.x,0,me.z):new THREE.Vector3();
      this.cameraTarget.lerp(target,Math.min(1,dt*5));
      this.camera.position.set(this.cameraTarget.x,64,this.cameraTarget.z+42);this.camera.lookAt(this.cameraTarget);
    }
    this.crystals.forEach((c,i)=>{c.rotation.y=time*.6+i;c.position.y+=(Math.sin(time*2+i)*.003);});
    this.dust.rotation.y=time*.008;
    const seen=new Set();
    if(state){
      const u=state.uplink,col=u?.contested?0xf9bd69:u?.owner!==null&&u?.owner!==undefined?COLORS[u.owner]:0xd6f56f;this.uplinkBeam.visible=!!u?.active;this.uplinkRing.material.color.set(u?.active?col:0x718679);this.uplinkBeam.material.color.set(col);this.uplinkBeam.material.opacity=.07+Math.sin(time*3)*.025;
      for(const p of state.players){
        seen.add(p.id);const a=this.avatars.get(p.id)||this.avatar(p);a.g.visible=!p.respawn&&!p.disconnected;a.label.visible=!p.respawn&&!p.disconnected&&!this.menu;
        a.g.position.lerp(new THREE.Vector3(p.x,0,p.z),Math.min(1,dt*16));
        if(a.g.position.lengthSq()<.01)a.g.position.set(p.x,0,p.z);
        const difference=Math.atan2(Math.sin(p.angle-a.g.rotation.y),Math.cos(p.angle-a.g.rotation.y));a.g.rotation.y+=difference*Math.min(1,dt*20);
        const moving=Math.hypot(p.x-a.lastX,p.z-a.lastZ)>.01;a.left.rotation.x=moving?Math.sin(time*18)*.45:0;a.right.rotation.x=-a.left.rotation.x;
        a.lastX=p.x;a.lastZ=p.z;a.shield.visible=p.shield>0;a.ring.visible=p.id===myId||p.deadlocked;a.ring.material.color.set(p.deadlocked?0xff6d62:0xd6f56f);
        a.label.position.set(a.g.position.x,3,a.g.position.z);a.label.material.color.set(p.deadlocked?0xff7164:0xffffff);
      }
      for(const [id,a]of this.avatars)if(!seen.has(id)){this.disposeObject(a.g);this.disposeObject(a.label);this.avatars.delete(id);}
      const bullets=new Set();
      for(const b of state.bullets){bullets.add(b.id);let m=this.projectiles.get(b.id);if(!m){m=new THREE.Mesh(new THREE.SphereGeometry(.16,6,6),new THREE.MeshBasicMaterial({color:COLORS[b.team]}));m.scale.z=2.7;this.world.add(m);this.projectiles.set(b.id,m);}m.position.set(b.x,1,b.z);m.rotation.y=Math.atan2(b.dx,b.dz);}
      for(const [id,m]of this.projectiles)if(!bullets.has(id)){this.disposeObject(m);this.projectiles.delete(id);}
      for(const r of state.resources){const g=this.nodeGroups.get(r.id),owner=state.players.find(p=>p.id===r.owner);g.children[3].material.color.set(owner?COLORS[owner.team]:r.color);}
      for(const e of state.events){if(typeof e.id==='number'&&e.id>this.eventId){if(Number.isFinite(e.x)&&['kill','score','recovery','skill','uplink'].includes(e.type))this.burst(e.x,e.z,e.type==='kill'?0xff9270:0xd6f56f);this.eventId=Math.max(this.eventId,e.id);}}
    }
    this.fx=this.fx.filter(f=>{f.life-=dt;f.mesh.position.addScaledVector(f.v,dt);f.v.y-=dt*12;f.mesh.scale.setScalar(Math.max(0,f.life));if(f.life<=0){this.disposeObject(f.mesh);return false;}return true;});
    this.renderer.render(this.scene,this.camera);
  }
  disposeObject(obj){obj.traverse(o=>{o.geometry?.dispose();if(o.material){o.material.map?.dispose();o.material.dispose();}});obj.parent?.remove(obj);}
}
