'use strict';
const crypto=require('crypto');
// Проверка подписи Telegram Mini App initData (HMAC-SHA256 по токену бота).
function verifyInitData(initData,token,maxAge=86400,now=Date.now()){
  if(typeof initData!=='string'||!initData||initData.length>4096||!token)return null;
  const p=new URLSearchParams(initData),hash=p.get('hash');
  if(!hash||!/^[0-9a-f]{64}$/.test(hash))return null;
  p.delete('hash');
  const dcs=[...p.entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([k,v])=>k+'='+v).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();
  const calc=crypto.createHmac('sha256',secret).update(dcs).digest();
  if(!crypto.timingSafeEqual(calc,Buffer.from(hash,'hex')))return null;
  const ad=Number(p.get('auth_date')),t=now/1000;
  if(!ad||t-ad>maxAge||ad-t>300)return null;
  try{const u=JSON.parse(p.get('user'));return Number.isSafeInteger(u.id)&&u.id>0?u:null}catch(e){return null}
}
// Только числовые Telegram ID; username для прав не используется.
function parseIds(...v){const s=new Set();v.filter(Boolean).join(',').split(',').forEach(x=>{x=x.trim();if(/^\d{1,15}$/.test(x))s.add(Number(x))});return s}
module.exports={verifyInitData,parseIds};
