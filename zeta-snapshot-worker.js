const TTL=24*60*60*1000;
const MAX=10*1024*1024;
const TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const ORIGIN='https://zeta-snapshot.kwillhs.workers.dev';

export default{async fetch(req,env){try{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors()});
  const u=new URL(req.url),p=u.pathname.replace(/\/+$/,'')||'/',a=p.split('/').filter(Boolean);
  if(p==='/mcp'){if(req.method!=='POST')return j({error:'Method not allowed'},405);return mcp(req,env)}
  if(req.method==='GET'&&p==='/')return j({ok:true,service:'ZETA Snapshot Relay',version:3,mcp:'/mcp'});
  if(req.method==='POST'&&a.length===1&&a[0]==='snapshots')return create(req,env);
  if(a[0]==='snapshots'&&a[1]){
    const t=a[1];
    if(req.method==='GET'&&a.length===2)return getSnap(req,env,t);
    if(req.method==='GET'&&a[2]==='status')return getStatus(env,t);
    if(req.method==='PATCH'&&a[2]==='status')return setStatus(req,env,t);
    if(req.method==='PUT'&&a[2]==='character-image')return upload(req,env,t,'character');
    if(req.method==='GET'&&a[2]==='character-image')return image(env,t,'character');
    if(req.method==='PUT'&&a[2]==='user-image')return upload(req,env,t,'user');
    if(req.method==='GET'&&a[2]==='user-image')return image(env,t,'user');
    if((req.method==='PUT'||req.method==='POST')&&a[2]==='result')return upload(req,env,t,'result');
    if(req.method==='GET'&&a[2]==='image')return image(env,t,'result');
    if(req.method==='DELETE'&&a.length===2)return del(env,t);
  }
  return j({error:'Not found'},404)
}catch(e){console.error(e);return j({error:String(e?.message||e)},500)}}};

async function create(req,env){
  const b=await req.json().catch(()=>null);if(!b||typeof b!=='object')return j({error:'Invalid JSON body'},400);
  const id=crypto.randomUUID(),token=rand(),now=Date.now(),exp=now+TTL,an=b.anchor||{};
  await env.DB.prepare("INSERT INTO snapshots (id,token,client_id,room_id,anchor_message_id,anchor_hash,anchor_preview,messages_json,character_json,user_profile_json,character_image_key,user_image_key,result_image_key,result_mime,status,error_message,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,'pending',NULL,?,?,?)")
    .bind(id,token,String(b.clientId||'anonymous'),String(b.roomId||'manual-room'),an.messageId||null,an.hash||null,an.preview||'',JSON.stringify(Array.isArray(b.messages)?b.messages:[]),JSON.stringify(b.character||{}),JSON.stringify(b.userProfile||{}),now,now,exp).run();
  const o=new URL(req.url).origin;
  return j({ok:true,snapshot:{id,token,roomId:String(b.roomId||'manual-room'),status:'pending',createdAt:now,updatedAt:now,expiresAt:exp,snapshotUrl:o+'/snapshots/'+encodeURIComponent(token),statusUrl:o+'/snapshots/'+encodeURIComponent(token)+'/status'}},201)
}

async function getSnap(req,env,t){const r=await row(env,t);if(!r)return j({error:'Snapshot not found'},404);if(expired(r))return j({error:'Snapshot expired'},410);return j({ok:true,snapshot:shape(r,new URL(req.url).origin)})}
async function getStatus(env,t){const r=await row(env,t);if(!r)return j({error:'Snapshot not found'},404);if(expired(r))return j({error:'Snapshot expired'},410);return j({ok:true,token:t,status:r.status,error:r.error_message||null,resultImageUrl:r.result_image_key?'/snapshots/'+encodeURIComponent(t)+'/image':null,updatedAt:r.updated_at,expiresAt:r.expires_at})}
async function setStatus(req,env,t){if(!await row(env,t))return j({error:'Snapshot not found'},404);const b=await req.json().catch(()=>({})),s=String(b.status||'');if(!new Set(['pending','processing','completed','failed']).has(s))return j({error:'Invalid status'},400);const now=Date.now(),e=b.error==null?null:String(b.error).slice(0,2000);await env.DB.prepare('UPDATE snapshots SET status=?,error_message=?,updated_at=? WHERE token=?').bind(s,e,now,t).run();return j({ok:true,token:t,status:s,error:e,updatedAt:now})}
async function upload(req,env,t,k){const r=await row(env,t);if(!r)return j({error:'Snapshot not found'},404);if(expired(r))return j({error:'Snapshot expired'},410);const m=mime(req.headers.get('content-type'));if(!TYPES.has(m))return j({error:'Unsupported image type'},415);const b=await req.arrayBuffer();if(!b.byteLength)return j({error:'Empty image'},400);if(b.byteLength>MAX)return j({error:'Image too large'},413);return j(await store(env,t,r,k,b,m))}
async function image(env,t,k){const r=await row(env,t);if(!r)return j({error:'Snapshot not found'},404);const key=k==='character'?r.character_image_key:k==='user'?r.user_image_key:r.result_image_key;if(!key)return j({error:'Image not found'},404);const o=await env.IMAGES.get(key);if(!o)return j({error:'Image not found'},404);const h=cors();h.set('Content-Type',k==='result'?(r.result_mime||o.httpMetadata?.contentType||'image/png'):(o.httpMetadata?.contentType||'image/png'));h.set('Cache-Control','private, max-age=300');return new Response(o.body,{headers:h})}
async function del(env,t){const r=await row(env,t);if(!r)return j({error:'Snapshot not found'},404);for(const k of [r.character_image_key,r.user_image_key,r.result_image_key].filter(Boolean))await env.IMAGES.delete(k);await env.DB.prepare('DELETE FROM snapshots WHERE token=?').bind(t).run();return j({ok:true})}

async function mcp(req,env){
  const q=await req.json().catch(()=>null);if(!q||q.jsonrpc!=='2.0')return err(null,-32600,'Invalid Request');const id=q.id??null;
  if(q.method==='initialize')return ok(id,{protocolVersion:q.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'zeta-snapshot',version:'3.0.0'},instructions:'Read snapshots with get_snapshot. After generating an image, save it with save_snapshot_result using the same token and generated image file.'});
  if(q.method==='notifications/initialized')return new Response(null,{status:204,headers:cors()});
  if(q.method==='ping')return ok(id,{});
  if(q.method==='tools/list')return ok(id,{tools:tools()});
  if(q.method==='tools/call'){try{return ok(id,await call(env,q.params?.name,q.params?.arguments||{}))}catch(e){return ok(id,{content:[{type:'text',text:String(e?.message||e)}],structuredContent:{ok:false,error:String(e?.message||e)},isError:true})}}
  return err(id,-32601,'Method not found')
}

function tools(){
  const file={type:'object',properties:{download_url:{type:'string'},file_id:{type:'string'},mime_type:{type:'string'},file_name:{type:'string'}},required:['download_url','file_id'],additionalProperties:false};
  const oneToken={type:'object',properties:{token:{type:'string',minLength:1}},required:['token'],additionalProperties:false};
  return [
    {name:'get_snapshot',title:'Get ZETA snapshot',description:'Load one ZETA snapshot by token, including characters, user profile, messages, style and stored image URLs.',inputSchema:oneToken,annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}},
    {name:'get_snapshot_status',title:'Get ZETA snapshot status',description:'Read the current status and result URL for one snapshot.',inputSchema:oneToken,annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}},
    {name:'get_snapshot_reference_images',title:'Get ZETA snapshot reference images',description:'Return stored character and user reference images for image generation.',inputSchema:oneToken,annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}},
    {name:'save_snapshot_result',title:'Save generated ZETA snapshot image',description:'Persist the generated image for a ZETA snapshot after image generation so the ZETA client can display it automatically.',inputSchema:{type:'object',$defs:{OpenAIFile:file},properties:{token:{type:'string',minLength:1},image:{$ref:'#/$defs/OpenAIFile'}},required:['token','image'],additionalProperties:false},annotations:{readOnlyHint:false,openWorldHint:true,destructiveHint:false},_meta:{'openai/fileParams':['image'],'openai/toolInvocation/invoking':'ZETA에 생성 이미지를 저장하는 중','openai/toolInvocation/invoked':'ZETA에 생성 이미지를 저장했어요'}}
  ]
}

async function call(env,n,a){
  if(n==='get_snapshot')return mGet(env,a);
  if(n==='get_snapshot_status')return mStatus(env,a);
  if(n==='get_snapshot_reference_images')return mRefs(env,a);
  if(n==='save_snapshot_result')return mSave(env,a);
  throw new Error('Unknown tool: '+n)
}
async function mGet(env,a){const t=need(a),r=await row(env,t);if(!r)throw new Error('Snapshot not found');if(expired(r))throw new Error('Snapshot expired');const s=shape(r,ORIGIN);return {content:[{type:'text',text:JSON.stringify(s)}],structuredContent:s,isError:false}}
async function mStatus(env,a){const t=need(a),r=await row(env,t);if(!r)throw new Error('Snapshot not found');const x={token:t,status:r.status,error:r.error_message||null,resultImageUrl:r.result_image_key?ORIGIN+'/snapshots/'+encodeURIComponent(t)+'/image':null,updatedAt:r.updated_at,expiresAt:r.expires_at};return {content:[{type:'text',text:JSON.stringify(x)}],structuredContent:x,isError:false}}
async function mRefs(env,a){const t=need(a),r=await row(env,t);if(!r)throw new Error('Snapshot not found');const c=[],refs=[];for(const [kind,key] of [['character',r.character_image_key],['user',r.user_image_key]]){if(!key)continue;const o=await env.IMAGES.get(key);if(!o)continue;const b=new Uint8Array(await o.arrayBuffer()),m=o.httpMetadata?.contentType||'image/png';c.push({type:'image',data:b64(b),mimeType:m});refs.push({kind,mimeType:m,sizeBytes:b.byteLength})}if(!c.length)c.push({type:'text',text:'No stored reference images.'});return {content:c,structuredContent:{token:t,references:refs},isError:false}}
async function mSave(env,a){
  const t=need(a),f=a?.image;if(!f||typeof f!=='object')throw new Error('Generated image file is required');if(!String(f.file_id||'').startsWith('file_'))throw new Error('Invalid ChatGPT file reference');
  let u;try{u=new URL(String(f.download_url||''))}catch{throw new Error('Invalid image download URL')}if(u.protocol!=='https:')throw new Error('Image download URL must use HTTPS');
  const r=await row(env,t);if(!r)throw new Error('Snapshot not found');if(expired(r))throw new Error('Snapshot expired');
  await env.DB.prepare("UPDATE snapshots SET status='processing',error_message=NULL,updated_at=? WHERE token=?").bind(Date.now(),t).run();
  const res=await fetch(u.toString(),{redirect:'follow'});if(!res.ok){await fail(env,t,'Generated image download failed: '+res.status);throw new Error('Generated image download failed: '+res.status)}
  const m=mime(f.mime_type||res.headers.get('content-type'));if(!TYPES.has(m)){await fail(env,t,'Unsupported image type: '+m);throw new Error('Unsupported generated image type')}
  const b=await res.arrayBuffer();if(!b.byteLength){await fail(env,t,'Generated image was empty');throw new Error('Generated image was empty')}if(b.byteLength>MAX){await fail(env,t,'Generated image was too large');throw new Error('Generated image too large')}
  await store(env,t,r,'result',b,m);const url=ORIGIN+'/snapshots/'+encodeURIComponent(t)+'/image';
  return {content:[{type:'text',text:'Saved generated image for ZETA snapshot.'}],structuredContent:{ok:true,token:t,status:'completed',resultImageUrl:url,sizeBytes:b.byteLength,mimeType:m},isError:false}
}

async function store(env,t,r,k,b,m){const ext=m==='image/jpeg'?'jpg':m==='image/webp'?'webp':m==='image/gif'?'gif':'png',key='snapshots/'+r.id+'/'+k+'.'+ext;await env.IMAGES.put(key,b,{httpMetadata:{contentType:m}});const now=Date.now();
  if(k==='character')await env.DB.prepare('UPDATE snapshots SET character_image_key=?,updated_at=? WHERE token=?').bind(key,now,t).run();
  else if(k==='user')await env.DB.prepare('UPDATE snapshots SET user_image_key=?,updated_at=? WHERE token=?').bind(key,now,t).run();
  else if(k==='result')await env.DB.prepare("UPDATE snapshots SET result_image_key=?,result_mime=?,status='completed',error_message=NULL,updated_at=? WHERE token=?").bind(key,m,now,t).run();
  else throw new Error('Invalid image kind');
  return {ok:true,key,kind:k,mimeType:m,sizeBytes:b.byteLength,updatedAt:now}
}
async function fail(env,t,e){await env.DB.prepare("UPDATE snapshots SET status='failed',error_message=?,updated_at=? WHERE token=?").bind(String(e).slice(0,2000),Date.now(),t).run()}
async function row(env,t){return env.DB.prepare('SELECT * FROM snapshots WHERE token=?').bind(t).first()}
function shape(r,o){const ch=parse(r.character_json,{}),op=ch?.snapshotOptions||{};return {id:r.id,token:r.token,clientId:r.client_id,roomId:r.room_id,anchor:{messageId:r.anchor_message_id||null,hash:r.anchor_hash||null,preview:r.anchor_preview||''},messages:parse(r.messages_json,[]),character:ch,userProfile:parse(r.user_profile_json,{}),stylePreset:op.stylePreset??null,stylePrompt:op.stylePrompt??null,additionalInstructions:op.additionalInstructions??null,characterImageUrl:r.character_image_key?o+'/snapshots/'+encodeURIComponent(r.token)+'/character-image':null,userImageUrl:r.user_image_key?o+'/snapshots/'+encodeURIComponent(r.token)+'/user-image':null,resultImageUrl:r.result_image_key?o+'/snapshots/'+encodeURIComponent(r.token)+'/image':null,status:r.status,error:r.error_message||null,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at}}
function need(a){const t=String(a?.token||'').trim();if(!/^[A-Za-z0-9_-]{16,200}$/.test(t))throw new Error('Invalid snapshot token');return t}
function expired(r){return Number(r.expires_at||0)>0&&Number(r.expires_at)<Date.now()}
function parse(v,d){try{return v?JSON.parse(v):d}catch{return d}}
function mime(v){return String(v||'').split(';')[0].trim().toLowerCase()}
function rand(){return b64url(crypto.getRandomValues(new Uint8Array(32)))}
function b64(b){let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s)}
function b64url(b){return b64(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
function cors(){return new Headers({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id','Access-Control-Expose-Headers':'Content-Type, MCP-Protocol-Version, Mcp-Session-Id'})}
function j(x,s=200){const h=cors();h.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(x,null,2),{status:s,headers:h})}
function ok(id,result){return j({jsonrpc:'2.0',id,result})}
function err(id,code,message){return j({jsonrpc:'2.0',id,error:{code,message}})}
