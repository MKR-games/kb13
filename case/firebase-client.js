import {createPlayerStore} from './player-store.js';
const VERSION='13.0.0';let connection;
export const isConfigured=()=>!!(window.KB13_FIREBASE_CONFIG?.apiKey&&window.KB13_FIREBASE_CONFIG?.projectId&&window.KB13_FIREBASE_CONFIG?.appId);
export async function connect(){
 if(!isConfigured())throw new Error('Firebase 프로젝트 연결 설정이 필요합니다.');
 if(connection)return connection;
 connection=(async()=>{
  const [apps,authSDK,fs]=await Promise.all([import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`),import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-auth.js`),import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-firestore.js`)]);
  const name='kb13-player',app=apps.getApps().find(x=>x.name===name)||apps.initializeApp(window.KB13_FIREBASE_CONFIG,name);
  const auth=authSDK.getAuth(app);await authSDK.setPersistence(auth,authSDK.browserLocalPersistence);await auth.authStateReady();
  if(!auth.currentUser)await authSDK.signInAnonymously(auth);
  const db=fs.initializeFirestore(app,{localCache:fs.memoryLocalCache()}),store=createPlayerStore({db,fs,uid:()=>auth.currentUser?.uid});
  return{watch:store.watch,call:async({op,...body})=>{
   try{if(!['state','attempt','reserve','claim'].includes(op))throw new Error('지원하지 않는 요청입니다.');return await(op==='state'||op==='reserve'?store[op]():store[op](body));}
   catch(e){if(e.code==='permission-denied')e.message='접수 권한이나 운영 상태가 변경되었습니다. 다시 확인해 주세요.';if(['resource-exhausted','unavailable'].includes(e.code))e.message='현재 기록실에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';throw e;}
  }};
 })();try{return await connection;}catch(e){connection=null;throw e;}
}
export async function publicCall(op,body={}){return(await connect()).call({op,...body});}
export async function watchPublic(handler,onError){return(await connect()).watch(handler,onError);}
