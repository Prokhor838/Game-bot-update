'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const {verifyInitData,parseIds}=require('./auth');
const CAT=require('./catalog');
const CASES=[{cost:100,odds:[60,25,10,4,1]},{cost:300,odds:[35,30,20,10,5]}];
const SW=[5,4,3,2,1],SM=[4,6,10,20,50],CAP=3000,DEF={g:0,w:0,l:0,lines:0,best:0,quiz:0,cases:0};
const ACH=[s=>s.g>=1,s=>s.w>=1,s=>s.cases>=1,s=>s.g>=10,s=>s.lines>=100,s=>s.quiz>=1,(s,r)=>r>=2,(s,r)=>r>=4];
class HttpErr extends Error{constructor(s,m){super(m);this.status=s}}
const bad=(m,s=400)=>new HttpErr(s,m);
const int=(v,lo,hi)=>{if(!Number.isInteger(v)||v<lo||v>hi)throw bad('Некорректное значение');return v};

function createApp(o){
  const db=new DatabaseSync(o.dbPath);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000');
  db.exec(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  const ins=db.prepare('INSERT OR IGNORE INTO catalog(id,name,descr,rarity,price,color) VALUES(?,?,?,?,?,?)');CAT.forEach(c=>ins.run(...c));
  const now=o.now||Date.now,day=()=>new Date(now()).toISOString().slice(0,10);
  const q=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);
  const load=id=>{const u=q('SELECT * FROM users WHERE id=?',id);if(!u)return null;u.st={...DEF,...JSON.parse(u.stats)};u.achv=JSON.parse(u.ach);u.rl=JSON.parse(u.rlast);return u};
  const save=u=>run('UPDATE users SET coins=?,daily=?,stats=?,ach=?,imported=?,rday=?,rtotal=?,rlast=? WHERE id=?',u.coins,u.daily,JSON.stringify(u.st),JSON.stringify(u.achv),u.imported,u.rday,u.rtotal,JSON.stringify(u.rl),u.id);
  const col=id=>{const c={};all('SELECT item,qty FROM items WHERE user_id=? AND qty>0',id).forEach(r=>c[r.item]=r.qty);return c};
  const addItem=(id,item,n)=>run('INSERT INTO items(user_id,item,qty) VALUES(?,?,?) ON CONFLICT(user_id,item) DO UPDATE SET qty=qty+?',id,item,n,n);
  const log=(a,uid,type,amount,result)=>run('INSERT INTO admin_log(admin_id,user_id,type,amount,result) VALUES(?,?,?,?,?)',a,uid??null,type,amount??null,result);
  function me(id){const u=load(id),n=new Date(now());return{id,username:u.username,coins:u.coins,col:col(id),st:u.st,ach:u.achv,daily:u.daily,day:day(),next:Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()+1),admin:o.admins.has(id),prices:all('SELECT price FROM catalog ORDER BY id').map(r=>r.price)}}
  function view(id){const u=q('SELECT id,username,first_name,coins,created_at,last_seen FROM users WHERE id=?',id);return u&&{...u,col:col(id)}}
  function act(uid,rid,fn){
    if(typeof rid!=='string'||!rid||rid.length>64)throw bad('Нужен идентификатор запроса');
    db.exec('BEGIN IMMEDIATE');
    try{const old=q('SELECT response FROM requests WHERE rid=? AND user_id=?',rid,uid);if(old){db.exec('COMMIT');return JSON.parse(old.response)}
      const res=fn();run('INSERT INTO requests(rid,user_id,response) VALUES(?,?,?)',rid,uid,JSON.stringify(res));db.exec('COMMIT');return res}
    catch(e){try{db.exec('ROLLBACK')}catch(_){}throw e}}
  function awards(u){const r=q('SELECT MAX(c.rarity) m FROM items i JOIN catalog c ON c.id=i.item WHERE i.user_id=? AND i.qty>0',u.id).m,nw=[];
    ACH.forEach((f,i)=>{if(!u.achv[i]&&f(u.st,r==null?-1:r)){u.achv[i]=1;u.coins+=50;nw.push(i)}});return nw}
  const mut=(id,rid,fn)=>act(id,rid,()=>{const u=load(id),out=fn(u)||{};out.newAch=awards(u);save(u);return{...out,me:me(id)}});

  const GAMES={
    ttt(u,a){int(a,1,3);return a==1?[20,'w']:a==3?[5,'d']:[0,'l']},
    guess(u,a){if(!a||typeof a!=='object')throw bad('Некорректное значение');const l=int(a.l,0,2);int(a.t,1,[7,8,10][l]);return a.w===1?[[30,60,150][l],'w']:[0,'l']},
    quiz(u,a){const k=int(a,0,10);u.st.quiz++;return[k*8,k>=6?'w':'l']},
    durak(u,a){const l=int(a,-1,3);return l<0?[0,'d']:l==0?[0,'l']:[60,'w']},
    blocks(u,a){if(!a||typeof a!=='object')throw bad('Некорректное значение');const s=int(a.score,0,30000),ln=int(a.lines,0,300);u.st.lines+=ln;u.st.best=Math.max(u.st.best,s);return[Math.min(200,Math.floor(s/50)),'d']}};
  const ops={
    reward(u,{kind,arg}){const f=GAMES[kind];if(!f)throw bad('Неизвестная игра');const t=now();if(t-(u.rl[kind]||0)<3000)throw bad('Слишком часто',429);u.rl[kind]=t;
      let[g,r]=f(u,arg);const d=day();if(u.rday!==d){u.rday=d;u.rtotal=0}g=Math.max(0,Math.min(g,CAP-u.rtotal));u.rtotal+=g;u.coins+=g;u.st.g++;if(r=='w')u.st.w++;if(r=='l')u.st.l++;return{gain:g}},
    slots(u,{bet}){if(![10,50,100].includes(bet))throw bad('Некорректная ставка');if(u.coins<bet)throw bad('Недостаточно монет');u.coins-=bet;
      const res=[0,0,0].map(()=>{let x=crypto.randomInt(15);for(let i=0;i<5;i++){if(x<SW[i])return i;x-=SW[i]}return 0});
      let pay=0;if(res[0]==res[1]&&res[1]==res[2])pay=bet*SM[res[0]];else if(res[0]==res[1]||res[1]==res[2]||res[0]==res[2])pay=bet;
      u.coins+=pay;u.st.g++;if(pay>bet)u.st.w++;else if(pay<bet)u.st.l++;return{res,pay}},
    cse(u,{c}){const cs=CASES[int(c,0,1)];if(u.coins<cs.cost)throw bad('Недостаточно монет');u.coins-=cs.cost;let r=crypto.randomInt(100),k=0;for(;k<4;k++){if(r<cs.odds[k])break;r-=cs.odds[k]}
      const pool=all('SELECT id FROM catalog WHERE rarity=?',k),item=pool[crypto.randomInt(pool.length)].id;addItem(u.id,item,1);u.st.cases++;u.st.g++;return{item}},
    sell(u,{item,qty}){int(item,0,CAT.length-1);int(qty,1,1000);const r=q('SELECT qty FROM items WHERE user_id=? AND item=?',u.id,item);if(!r||r.qty<qty)throw bad('Нет такого кристалла в нужном количестве');
      const p=q('SELECT price FROM catalog WHERE id=?',item).price;run('UPDATE items SET qty=qty-? WHERE user_id=? AND item=?',qty,u.id,item);run('DELETE FROM items WHERE user_id=? AND item=? AND qty=0',u.id,item);u.coins+=p*qty;return{gain:p*qty}},
    daily(u){const d=day();if(u.daily===d)throw bad('Награда за сегодня уже получена');u.daily=d;u.coins+=100;return{gain:100}},
    reset(u){run('DELETE FROM items WHERE user_id=?',u.id);u.coins=500;u.st={...DEF};u.achv={};u.rday='';u.rtotal=0;u.rl={};return{}},
    imp(u,{data}){if(u.imported)throw bad('Импорт уже выполнялся');if(!data||typeof data!=='object')throw bad('Нет данных');
      const n=(v,m)=>Number.isInteger(v)&&v>0?Math.min(v,m):0,c=n(data.coins,1000);u.coins+=c;for(let k=0;k<CAT.length;k++){const x=n((data.col||{})[k],5);if(x)addItem(u.id,k,x)}
      const s=data.st||{};u.st.g+=n(s.g,1000);u.st.w+=n(s.w,1000);u.st.l+=n(s.l,1000);u.st.lines+=n(s.lines,5000);u.st.quiz+=n(s.quiz,100);u.st.cases+=n(s.cases,100);u.st.best=Math.max(u.st.best,n(s.best,30000));u.imported=1;return{imported:c}}};

  function admin(a,rid,type,uid,amount,fn){
    try{return act(a,rid,()=>{const t=load(uid);if(!t)throw bad('Пользователь не найден',404);const r=fn(t);log(a,uid,type,amount,'ok: '+r.note);return{result:r.note,user:view(uid)}})}
    catch(e){if(e instanceof HttpErr&&uid)log(a,uid,type,amount,'rejected: '+e.message);throw e}}
  const adm={
    coins(a,b){const uid=int(b.uid,1,Number.MAX_SAFE_INTEGER),op=b.op;if(!['give','take','set'].includes(op))throw bad('Некорректная операция');const amt=int(b.amount,op=='set'?0:1,1e9);
      return admin(a,b.rid,'coins_'+op,uid,amt,t=>{let c=t.coins;if(op=='give')c+=amt;else if(op=='take'){if(c<amt)throw bad('Недостаточно монет у пользователя');c-=amt}else c=amt;if(c>1e12)throw bad('Слишком большой баланс');run('UPDATE users SET coins=? WHERE id=?',c,uid);return{note:t.coins+' → '+c}})},
    crystals(a,b){const uid=int(b.uid,1,Number.MAX_SAFE_INTEGER),op=b.op;if(!['give','take'].includes(op))throw bad('Некорректная операция');const item=int(b.item,0,CAT.length-1),qty=int(b.qty,1,1000);
      return admin(a,b.rid,'crystal_'+op,uid,qty,t=>{const nm=q('SELECT name FROM catalog WHERE id=?',item).name;if(op=='give')addItem(uid,item,qty);else{const r=q('SELECT qty FROM items WHERE user_id=? AND item=?',uid,item);if(!r||r.qty<qty)throw bad('У пользователя недостаточно экземпляров');run('UPDATE items SET qty=qty-? WHERE user_id=? AND item=?',qty,uid,item);run('DELETE FROM items WHERE user_id=? AND item=? AND qty=0',uid,item)}
        return{note:(op=='give'?'+':'-')+qty+' × '+nm}})},
    price(a,b){const item=int(b.item,0,CAT.length-1),p=int(b.price,0,1e9);return act(a,b.rid,()=>{const old=q('SELECT price,name FROM catalog WHERE id=?',item);run('UPDATE catalog SET price=? WHERE id=?',p,item);log(a,null,'price',p,'ok: '+old.name+' '+old.price+' → '+p);return{result:old.name+': '+p,prices:all('SELECT price FROM catalog ORDER BY id').map(r=>r.price)}})}};
  function backups(){try{return fs.readdirSync(o.backupDir).filter(n=>/^gamebot-.*\.db$/.test(n)).sort()}catch(e){return[]}}
  function backup(){if(!o.backupDir||o.dbPath===':memory:')return;fs.mkdirSync(o.backupDir,{recursive:true});const f=path.join(o.backupDir,'gamebot-'+day()+'.db');if(!fs.existsSync(f))db.exec("VACUUM INTO '"+f.replace(/'/g,"''")+"'");backups().slice(0,-7).forEach(n=>fs.unlinkSync(path.join(o.backupDir,n)))}

  const json=(res,s,d)=>{res.writeHead(s,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(d))};
  const body=req=>new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>10000){no(bad('Слишком большой запрос',413));req.destroy()}});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch(e){no(bad('Некорректный JSON'))}})});
  async function handle(req,res){
    try{const url=new URL(req.url,'http://x'),p=url.pathname;
      if(req.method==='GET'&&(p==='/'||p==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});return res.end(fs.readFileSync(o.indexPath))}
      if(p==='/healthz')return json(res,200,{ok:true});
      if(!p.startsWith('/api/'))throw bad('Не найдено',404);
      const tu=verifyInitData(req.headers['x-init-data'],o.token,86400,now());if(!tu)throw bad('Требуется вход через Telegram',401);
      run("INSERT INTO users(id,username,first_name,last_seen) VALUES(?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_seen=datetime('now')",tu.id,tu.username||null,tu.first_name||null);
      const id=tu.id,isA=o.admins.has(id),b=req.method==='POST'?await body(req):{};
      if(req.method==='GET'&&p==='/api/me')return json(res,200,{me:me(id)});
      const U={'/api/reward':'reward','/api/slots':'slots','/api/case':'cse','/api/sell':'sell','/api/daily':'daily','/api/reset':'reset','/api/import':'imp'};
      if(req.method==='POST'&&U[p])return json(res,200,mut(id,b.rid,u=>ops[U[p]](u,b)));
      if(p.startsWith('/api/admin/')){
        if(!isA)throw bad('Нет доступа',403);
        if(req.method==='GET'&&p==='/api/admin/users'){let s=String(url.searchParams.get('q')||'').trim().replace(/^@/,'').replace(/[%_]/g,''),r;
          r=!s?all('SELECT id,username,first_name,coins FROM users ORDER BY last_seen DESC LIMIT 30'):/^\d+$/.test(s)?all('SELECT id,username,first_name,coins FROM users WHERE id=? OR username LIKE ? LIMIT 30',Number(s),s+'%'):all('SELECT id,username,first_name,coins FROM users WHERE username LIKE ? LIMIT 30',s+'%');return json(res,200,{users:r})}
        const m=p.match(/^\/api\/admin\/user\/(\d{1,15})$/);if(req.method==='GET'&&m){const v=view(Number(m[1]));if(!v)throw bad('Пользователь не найден',404);return json(res,200,{user:v})}
        if(req.method==='GET'&&p==='/api/admin/stats'){const g=t=>q("SELECT COALESCE(SUM(amount),0) s FROM admin_log WHERE type=? AND result LIKE 'ok%'",t).s;return json(res,200,{users:q('SELECT COUNT(*) c FROM users').c,coins:q('SELECT COALESCE(SUM(coins),0) s FROM users').s,crystals:q('SELECT COALESCE(SUM(qty),0) s FROM items').s,given:g('crystal_give'),taken:g('crystal_take'),ops:q("SELECT COUNT(*) c FROM admin_log WHERE result LIKE 'ok%'").c,rejected:q("SELECT COUNT(*) c FROM admin_log WHERE result LIKE 'rejected%'").c,backups:backups()})}
        if(req.method==='GET'&&p==='/api/admin/log')return json(res,200,{log:all('SELECT * FROM admin_log ORDER BY id DESC LIMIT 100')});
        if(req.method==='POST'&&p==='/api/admin/coins')return json(res,200,adm.coins(id,b));
        if(req.method==='POST'&&p==='/api/admin/crystals')return json(res,200,adm.crystals(id,b));
        if(req.method==='POST'&&p==='/api/admin/price')return json(res,200,adm.price(id,b));
      }
      throw bad('Не найдено',404)}
    catch(e){if(e instanceof HttpErr)return json(res,e.status,{error:e.message});console.error(e);json(res,500,{error:'Ошибка сервера'})}}
  const server=http.createServer(handle);
  return{server,db,backup,close(){server.close();db.close()}}
}
module.exports={createApp,CASES};
if(require.main===module){
  const token=process.env.BOT_TOKEN;if(!token){console.error('Не задана переменная BOT_TOKEN');process.exit(1)}
  const admins=parseIds(process.env.ADMIN_IDS,process.env.CASINO_ADMIN_IDS);if(!admins.size)console.warn('ADMIN_IDS не задан: админ-панель недоступна');
  const dbPath=process.env.DB_PATH||path.join(__dirname,'data','gamebot.db');fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const app=createApp({dbPath,token,admins,indexPath:path.join(__dirname,'index.html'),backupDir:process.env.BACKUP_DIR||path.join(path.dirname(dbPath),'backups')});
  try{app.backup()}catch(e){console.error('backup:',e.message)}setInterval(()=>{try{app.backup()}catch(e){console.error('backup:',e.message)}},6*3600*1000);
  app.server.listen(process.env.PORT||3000,()=>console.log('GAME BOT 2.0 слушает порт',process.env.PORT||3000,'| БД:',dbPath));
}
