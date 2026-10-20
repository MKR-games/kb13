// Spark-only storage. All authoritative checks live in firestore.rules.
const HOLD_MS=600000,DAY=86400000;
const ms=t=>t?.toMillis?.()||0;
const uuid=()=>crypto.randomUUID();
const denied=e=>e?.code==='permission-denied';
function fail(message,code='VALIDATION'){const e=new Error(message);e.code=code;throw e;}
export function normalizePhone(value){return String(value||'').trim().replace(/[\s().-]/g,'').replace(/^\+82/,'0');}
export async function phoneDigest(phone){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(phone))),n=>n.toString(16).padStart(2,'0')).join('');}
export function createPlayerStore({db,fs,uid}){
 const ref=(...path)=>fs.doc(db,...path),stamp=()=>fs.serverTimestamp(),who=()=>typeof uid==='function'?uid():uid;
 const read=async(...path)=>{const s=await fs.getDocFromServer(ref(...path));return s.exists()?s.data():null;};
 const config=()=>read('kb13Public','config');
 async function verdict(id,a){
  const existing=await read('kb13Players',who(),'verdicts',id);if(existing)return existing;
  for(const correct of [true,false]){
   try{await fs.setDoc(ref('kb13Players',who(),'verdicts',id),{correct,requestId:a.requestId,createdAt:stamp()});return{correct,requestId:a.requestId};}
   catch(e){if(!denied(e))throw e;const concurrent=await read('kb13Players',who(),'verdicts',id);if(concurrent)return concurrent;if(!correct)throw e;}
  }
 }
 async function progress(){
  const out=[];
  for(const id of ['1','2','3']){const a=await read('kb13Players',who(),'attempts',id);if(!a)break;const v=await verdict(id,a);out.push({id,...a,...v});if(v.correct)break;}
  return out;
 }
 async function context(){
  const [c,availability,p,attempts]=await Promise.all([config(),read('kb13Public','availability'),read('kb13Players',who()),progress()]);
  return{c,availability,p,attempts};
 }
 function view(x){
  const now=Date.now(),base={config:x.c,attemptsLeft:3-x.attempts.length,serverTime:now};
  if(x.p?.status==='confirmed')return{...base,state:'receipt',receipt:x.p.receipt,erased:x.p.erased};
  if(x.p?.status==='held'&&ms(x.p.heldAt)+HOLD_MS>now)return{...base,state:'claim',expires:ms(x.p.heldAt)+HOLD_MS};
  if(!x.c)return{...base,state:'paused',config:{mode:'paused',organizer:'전시 운영팀',contact:'현장 운영자',purpose:'경품 배송 및 수령 안내',retentionDays:30,version:''},setupPending:true};
  if(x.availability?.closed||x.c.mode==='closed')return{...base,state:'closed'};
  if(x.c.mode!=='open')return{...base,state:'paused'};
  if(x.attempts.some(a=>a.correct))return{...base,state:'expired'};
  return{...base,state:x.attempts.length>=3?'locked':'mission'};
 }
 async function reserve(x=undefined){
  x??=await context();const winning=x.attempts.find(a=>a.correct),current=view(x);
  if(!winning||['receipt','claim','closed','paused'].includes(current.state))return current;
  const id=who();
  for(const slot of ['1','2','3']){
   const holdId=uuid(),batch=fs.writeBatch(db),p={slot,holdId,attemptId:winning.id,heldAt:stamp(),receipt:uuid().replaceAll('-','').slice(0,8).toUpperCase(),status:'held',confirmedAt:null,retentionDays:0,phoneHash:'',shippedAt:null,erased:false,erasedAt:null};
   batch.set(ref('kb13Players',id),p);
   batch.set(ref('kb13Slots',slot),{owner:id,holdId,attemptId:winning.id,heldAt:stamp(),status:'held'});
   try{await batch.commit();x.p=await read('kb13Players',id);return view(x);}catch(e){if(!denied(e))throw e;}
  }
  // Another tab may already have acquired a slot for this account.
  const next=await context();return view(next);
 }
 async function state(){const x=await context();if(!x.p&&x.attempts.some(a=>a.correct))return reserve(x);return view(x);}
 async function attemptCode(body){
  const code=String(body.code||'').trim().toUpperCase();if(!/^[A-Z0-9]{3}$/.test(code))fail('영문·숫자 세 자리를 입력해 주세요.');
  if(!/^[a-f0-9-]{36}$/.test(body.requestId||''))fail('다시 제출해 주세요.');
  const x=await context(),old=x.attempts.find(a=>a.requestId===body.requestId);
  if(old){const result=old.correct?await reserve(x):view(x);return{...result,outcome:old.correct?'success':'failure'};}
  const before=view(x);if(before.state!=='mission')return before;
  const id=String(x.attempts.length+1);
  try{await fs.setDoc(ref('kb13Players',who(),'attempts',id),{code,requestId:body.requestId,createdAt:stamp()});}
  catch(e){if(!denied(e))throw e;const actual=await read('kb13Players',who(),'attempts',id);if(actual?.requestId!==body.requestId)return state();}
  const fresh=await context(),a=fresh.attempts.find(a=>a.requestId===body.requestId);
  if(!a)return view(fresh);
  return{...(a.correct?await reserve(fresh):view(fresh)),outcome:a.correct?'success':'failure'};
 }
 async function claim(body){
  const x=await context();if(x.p?.status==='confirmed')return view(x);
  if(view(x).state!=='claim')fail('접수 시간이 지났습니다. 다시 확인해 주세요.','EXPIRED');
  if(body.version!==x.c.version)fail('개인정보 안내가 변경되었습니다. 다시 확인하고 동의해 주세요.','POLICY_CHANGED');
  if(body.consent!==true)fail('개인정보 수집·이용 동의가 필요합니다.');
  const personal={name:String(body.name||'').trim(),phone:normalizePhone(body.phone),postal:String(body.postal||'').trim(),address:String(body.address||'').trim(),detail:String(body.detail||'').trim()};
  if(personal.name.length<2||personal.name.length>60||!/^0\d{8,14}$/.test(personal.phone)||!/^\d{5}$/.test(personal.postal)||personal.address.length<5||personal.address.length>240||personal.detail.length>160)fail('이름·연락처·우편번호·주소를 확인해 주세요.');
  const id=who(),phoneHash=await phoneDigest(personal.phone),c=x.c;
  const consent={agreed:true,agreedAt:stamp(),version:c.version,organizer:c.organizer,contact:c.contact,purpose:c.purpose,retentionDays:c.retentionDays,extraNotice:c.extraNotice};
  // Slot contents are private. Rules select the correct closed flag atomically.
  for(const closed of [false,true]){
   const b=fs.writeBatch(db);
   b.update(ref('kb13Players',id),{status:'confirmed',confirmedAt:stamp(),retentionDays:c.retentionDays,phoneHash});
   b.update(ref('kb13Slots',x.p.slot),{status:'confirmed'});
   b.set(ref('kb13Recipients',id),{personal,consent,confirmedAt:stamp(),retentionDays:c.retentionDays});
   b.set(ref('kb13PhoneLocks',phoneHash),{owner:id,createdAt:stamp()});
   b.set(ref('kb13Public','availability'),{closed});
   try{await b.commit();return state();}catch(e){if(!denied(e))throw e;}
  }
  const next=await context();if(next.p?.status==='confirmed')return view(next);
  if(next.c.version!==body.version)fail('개인정보 안내가 변경되었습니다. 다시 확인하고 동의해 주세요.','POLICY_CHANGED');
  if(view(next).state!=='claim')fail('접수 시간이 지났습니다. 다시 확인해 주세요.','EXPIRED');
  fail('이미 접수한 연락처인지, 입력 내용이 올바른지 확인해 주세요. 계속 실패하면 현장 운영자에게 문의해 주세요.','CLAIM_REJECTED');
 }
 function watch(handler,onError=()=>{}){let timer;const notify=()=>{clearTimeout(timer);timer=setTimeout(handler,150);};const stops=['config','availability'].map(id=>fs.onSnapshot(ref('kb13Public',id),notify,onError));return()=>{clearTimeout(timer);stops.forEach(stop=>stop());};}
 return{state,attempt:attemptCode,reserve,claim,watch};
}
