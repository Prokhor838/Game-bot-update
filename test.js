'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),path=require('path');
const {createApp,CASES}=require('./server'),{verifyInitData,parseIds}=require('./auth');
const TOKEN='123456:TEST_TOKEN_ONLY',ADMIN=900,USER=100,USER2=101;let T=Date.now();
const sign=(user,token=TOKEN,ad=Math.floor(T/1000))=>{const p=new URLSearchParams({auth_date:String(ad),query_id:'q',user:JSON.stringify(user)});
  const dcs=[...p.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>k+'='+v).join('\n');const s=crypto.createHmac('sha256','WebAppData').update(token).digest();
  p.set('hash',crypto.createHmac('sha256',s).update(dcs).digest('hex'));return p.toString()};
const app=createApp({dbPath:':memory:',token:TOKEN,admins:parseIds('900,abc, 7x','901'),indexPath:path.join(__dirname,'index.original.html'),now:()=>T});
let port;const rid=()=>crypto.randomUUID();
async function call(uid,method,p,b,init){const h={'Content-Type':'application/json'};const ii=init===undefined?sign({id:uid,username:'u'+uid,first_name:'U'}):init;if(ii)h['X-Init-Data']=ii;
  const r=await fetch('http://127.0.0.1:'+port+p,{method,headers:h,body:method=='POST'?JSON.stringify({rid:rid(),...b}):undefined});return{s:r.status,d:await r.json()}}
const bal=async id=>(await call(id,'GET','/api/me')).d.me.coins;
test.before(async()=>{await new Promise(r=>app.server.listen(0,r));port=app.server.address().port});
test.after(()=>app.close());

test('initData: верная, подделанная, чужой токен, просроченная',()=>{
  const ok=sign({id:5});assert.equal(verifyInitData(ok,TOKEN,86400,T).id,5);
  assert.equal(verifyInitData(ok.replace('%22id%22%3A5','%22id%22%3A6'),TOKEN,86400,T),null);
  assert.equal(verifyInitData(sign({id:5},'999:OTHER'),TOKEN,86400,T),null);
  assert.equal(verifyInitData(sign({id:5},TOKEN,Math.floor(T/1000)-90000),TOKEN,86400,T),null);
  assert.equal(verifyInitData('',TOKEN),null);assert.equal(verifyInitData('hash=abc',TOKEN),null)});
test('ADMIN_IDS: только числовые ID',()=>assert.deepEqual([...parseIds('900,abc, 7x','901')].sort(),[900,901]));
test('без подписи и с неверной подписью — 401',async()=>{assert.equal((await call(1,'GET','/api/me',null,'')).s,401);assert.equal((await call(1,'GET','/api/me',null,'hash=00&auth_date=1')).s,401)});
test('новый пользователь: 500 монет; admin-флаг только по ID',async()=>{const a=await call(USER,'GET','/api/me'),b=await call(ADMIN,'GET','/api/me');
  assert.equal(a.d.me.coins,500);assert.equal(a.d.me.admin,false);assert.equal(b.d.me.admin,true);assert.equal(a.d.me.prices.length,10)});
test('обычный пользователь не может вызвать админ-API',async()=>{
  for(const[m,p,b]of[['GET','/api/admin/users'],['GET','/api/admin/user/100'],['GET','/api/admin/stats'],['GET','/api/admin/log'],['POST','/api/admin/coins',{uid:USER,op:'give',amount:1000}],['POST','/api/admin/crystals',{uid:USER,op:'give',item:9,qty:5}],['POST','/api/admin/price',{item:0,price:1}]])
    assert.equal((await call(USER,m,p,b)).s,403,p);assert.equal(await bal(USER),500)});
test('админ: выдать/забрать/установить монеты другому и себе',async()=>{
  for(const t of[USER,ADMIN]){await call(t,'GET','/api/me');const s=await bal(t);
    let r=await call(ADMIN,'POST','/api/admin/coins',{uid:t,op:'give',amount:250});assert.equal(r.s,200);assert.equal(await bal(t),s+250);
    r=await call(ADMIN,'POST','/api/admin/coins',{uid:t,op:'take',amount:50});assert.equal(await bal(t),s+200);
    r=await call(ADMIN,'POST','/api/admin/coins',{uid:t,op:'set',amount:777});assert.equal(r.d.user.coins,777);assert.equal(await bal(t),777)}});
test('админ: некорректные суммы и перерасход отклоняются, баланс не меняется',async()=>{
  const s=await bal(USER);
  for(const amount of[-5,0,1.5,'10',1e10,null])assert.equal((await call(ADMIN,'POST','/api/admin/coins',{uid:USER,op:'give',amount})).s,400);
  assert.equal((await call(ADMIN,'POST','/api/admin/coins',{uid:USER,op:'take',amount:s+1})).s,400);
  assert.equal((await call(ADMIN,'POST','/api/admin/coins',{uid:USER,op:'set',amount:-1})).s,400);
  assert.equal((await call(ADMIN,'POST','/api/admin/coins',{uid:555999,op:'give',amount:5})).s,404);assert.equal(await bal(USER),s)});
test('админ: кристаллы себе и другому, изъятие, нехватка экземпляров',async()=>{
  for(const t of[USER,ADMIN]){let r=await call(ADMIN,'POST','/api/admin/crystals',{uid:t,op:'give',item:9,qty:3});assert.equal(r.d.user.col[9],3);
    r=await call(ADMIN,'POST','/api/admin/crystals',{uid:t,op:'take',item:9,qty:1});assert.equal(r.d.user.col[9],2);
    r=await call(ADMIN,'POST','/api/admin/crystals',{uid:t,op:'take',item:9,qty:5});assert.equal(r.s,400);
    assert.equal((await call(t,'GET','/api/me')).d.me.col[9],2)}
  assert.equal((await call(ADMIN,'POST','/api/admin/crystals',{uid:USER,op:'give',item:99,qty:1})).s,400);
  assert.equal((await call(ADMIN,'POST','/api/admin/crystals',{uid:USER,op:'take',item:0,qty:1})).s,400)});
test('повтор админ-запроса с тем же rid не удваивает выдачу',async()=>{const r='dup-'+rid(),s=await bal(USER2);await call(USER2,'GET','/api/me');
  const b={uid:USER2,op:'give',amount:100,rid:r};const h={'Content-Type':'application/json','X-Init-Data':sign({id:ADMIN})};
  for(let i=0;i<3;i++)await fetch('http://127.0.0.1:'+port+'/api/admin/coins',{method:'POST',headers:h,body:JSON.stringify(b)});assert.equal(await bal(USER2),s+100)});
test('продажа: начисляет цену, нельзя продать лишнее, повтор rid не платит дважды',async()=>{
  await call(USER2,'GET','/api/me');await call(ADMIN,'POST','/api/admin/crystals',{uid:USER2,op:'give',item:8,qty:2});const s=await bal(USER2);
  const r='sell-1',h={'Content-Type':'application/json','X-Init-Data':sign({id:USER2})};
  for(let i=0;i<3;i++)await fetch('http://127.0.0.1:'+port+'/api/sell',{method:'POST',headers:h,body:JSON.stringify({item:8,qty:1,rid:r})});
  const after=await bal(USER2);assert.equal(after,s+1200+100);/* +100 = два достижения за редкость, один раз */assert.equal((await call(USER2,'GET','/api/me')).d.me.col[8],1);
  assert.equal((await call(USER2,'POST','/api/sell',{item:8,qty:2})).s,400);assert.equal((await call(USER2,'POST','/api/sell',{item:3,qty:1})).s,400);assert.equal(await bal(USER2),after)});
test('админ меняет цену — применяется к следующим продажам',async()=>{
  assert.equal((await call(ADMIN,'POST','/api/admin/price',{item:8,price:1500})).s,200);const s=await bal(USER2);
  const r=await call(USER2,'POST','/api/sell',{item:8,qty:1});assert.equal(r.d.gain,1500);assert.equal(await bal(USER2),s+1500);assert.equal(r.d.me.prices[8],1500);
  assert.equal((await call(USER,'POST','/api/admin/price',{item:8,price:1})).s,403);assert.equal((await call(ADMIN,'POST','/api/admin/price',{item:8,price:-1})).s,400)});
test('кейсы: вероятности = 100%, списание один раз, предмет сохранён, нехватка монет',async()=>{
  CASES.forEach(c=>assert.equal(c.odds.reduce((a,b)=>a+b),100));
  const U=300;await call(U,'GET','/api/me');await call(ADMIN,'POST','/api/admin/coins',{uid:U,op:'set',amount:350});
  const r=await call(U,'POST','/api/case',{c:1});assert.equal(r.s,200);const nA=r.d.newAch.length;assert.ok(nA>=2);assert.equal(r.d.me.coins,50+50*nA);assert.ok(r.d.me.col[r.d.item]>=1);assert.ok(r.d.me.ach[2]===1);
  await call(ADMIN,'POST','/api/admin/coins',{uid:U,op:'set',amount:50});assert.equal((await call(U,'POST','/api/case',{c:0})).s,400);assert.equal(await bal(U),50)});
test('слоты: баланс = до − ставка + выплата; неверная ставка отклоняется',async()=>{
  const U=301;await call(U,'GET','/api/me');let c=500;for(let i=0;i<20;i++){const r=await call(U,'POST','/api/slots',{bet:10});assert.equal(r.s,200);c=c-10+r.d.pay+50*r.d.newAch.length;assert.equal(r.d.me.coins,c)}
  assert.equal((await call(U,'POST','/api/slots',{bet:7})).s,400)});
test('ежедневная награда один раз в день (UTC)',async()=>{
  const U=302;await call(U,'GET','/api/me');assert.equal((await call(U,'POST','/api/daily',{})).d.gain,100);assert.equal((await call(U,'POST','/api/daily',{})).s,400);assert.equal(await bal(U),600);
  T+=86400000;assert.equal((await call(U,'POST','/api/daily',{})).s,200);assert.equal(await bal(U),700)});
test('награды игр: фиксированные суммы, частота, границы, повтор rid, суточный лимит',async()=>{
  const U=303;await call(U,'GET','/api/me');let r=await call(U,'POST','/api/reward',{kind:'ttt',arg:1});assert.equal(r.d.gain,20);
  assert.equal((await call(U,'POST','/api/reward',{kind:'ttt',arg:1})).s,429);T+=4000;
  assert.equal((await call(U,'POST','/api/reward',{kind:'quiz',arg:11})).s,400);assert.equal((await call(U,'POST','/api/reward',{kind:'quiz',arg:-1})).s,400);
  assert.equal((await call(U,'POST','/api/reward',{kind:'nope',arg:1})).s,400);assert.equal((await call(U,'POST','/api/reward',{kind:'guess',arg:{l:0,w:1,t:99}})).s,400);
  const h={'Content-Type':'application/json','X-Init-Data':sign({id:U})},s=await bal(U);let first;
  for(let i=0;i<3;i++){const f=await fetch('http://127.0.0.1:'+port+'/api/reward',{method:'POST',headers:h,body:JSON.stringify({kind:'quiz',arg:10,rid:'same'})});const j=await f.json();if(!i)first=j}assert.equal(first.gain,80);assert.equal(await bal(U),s+80+50*first.newAch.length);
  let total=100;for(let i=0;i<60&&total<3400;i++){T+=4000;const x=await call(U,'POST','/api/reward',{kind:'blocks',arg:{score:20000,lines:10}});total+=x.d.gain}
  T+=4000;const x=await call(U,'POST','/api/reward',{kind:'blocks',arg:{score:20000,lines:1}});assert.equal(x.s,200);assert.equal(x.d.gain,0)});
test('достижения: выдаются один раз, по реальным условиям',async()=>{
  const U=304;await call(U,'GET','/api/me');const r=await call(U,'POST','/api/reward',{kind:'ttt',arg:1});assert.deepEqual(r.d.newAch.sort(),[0,1]);
  T+=4000;const r2=await call(U,'POST','/api/reward',{kind:'ttt',arg:1});assert.deepEqual(r2.d.newAch,[]);assert.equal(r2.d.me.coins,500+40+100)});
test('импорт: один раз и с ограничениями',async()=>{
  const U=305;await call(U,'GET','/api/me');const d={coins:999999,col:{0:50,9:2,77:1},st:{g:5000,best:999999}};const r=await call(U,'POST','/api/import',{data:d});
  assert.equal(r.d.me.coins,1500+50*r.d.newAch.length);assert.equal(r.d.me.col[0],5);assert.equal(r.d.me.st.g,1000);assert.equal(r.d.me.st.best,30000);assert.equal((await call(U,'POST','/api/import',{data:d})).s,400)});
test('журнал и статистика: действия админа над собой и отказы записаны',async()=>{
  const l=(await call(ADMIN,'GET','/api/admin/log')).d.log;assert.ok(l.some(x=>x.user_id==ADMIN&&x.admin_id==ADMIN&&x.type=='coins_give'&&x.result.startsWith('ok')));
  assert.ok(l.some(x=>x.result.startsWith('rejected')));const s=(await call(ADMIN,'GET','/api/admin/stats')).d;assert.ok(s.users>=5&&s.ops>5&&s.given>=6&&s.taken>=2);
  const u=(await call(ADMIN,'GET','/api/admin/users?q=u'+ADMIN)).d.users;assert.ok(u.some(x=>x.id==ADMIN));assert.ok((await call(ADMIN,'GET','/api/admin/users?q=100')).d.users.some(x=>x.id==100))});
test('сброс прогресса возвращает 500 монет и очищает коллекцию',async()=>{const r=await call(USER,'POST','/api/reset',{});assert.equal(r.d.me.coins,500);assert.deepEqual(r.d.me.col,{})});
test('баланс не может стать отрицательным на уровне БД',()=>assert.throws(()=>app.db.prepare('UPDATE users SET coins=-1 WHERE id=?').run(USER)));
