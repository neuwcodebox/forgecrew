const fs=require('node:fs'),path=require('node:path');
const dir=process.env.FORGECREW_DATA_DIR,id=process.env.FORGECREW_VERSION_ID;
const send=m=>process.send?.({...m,protocolVersion:1});
const record=event=>fs.appendFileSync(path.join(dir,'fixture-events.jsonl'),JSON.stringify({id,event})+'\n');
record('started');let requested;
process.on('message',m=>{
  if(m.type==='STOP'){record('stopped');process.exit(0);}
  if(m.type==='HEALTH')send({type:'HEALTH'});
  if(m.type==='ACTIVATE')record('activated');
  if(m.type==='STAGE_ACCEPTED')send({type:'SWITCH',id:m.id});
});
setInterval(()=>{
  try{const r=JSON.parse(fs.readFileSync(path.join(dir,'fixture-request.json'),'utf8'));if(r.from===id&&requested!==r.id){requested=r.id;send({type:'STAGE_READY',id:r.id,policy:r.policy});}}catch{}
},20);
send({type:'READY'});
if(id.startsWith('bad'))process.exit(42);
