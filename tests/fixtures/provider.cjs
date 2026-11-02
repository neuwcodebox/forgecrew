const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const [scenario,log,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log('fixture-runtime 1.0');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
const send=value=>console.log(JSON.stringify(value));
const parameter=key=>args[args.indexOf(key)+1];
let model=parameter('--model')||'claude-opus-5-5',turnId='turn_1';
const codex=scenario.startsWith('codex');
function codexEnd(status='completed') {
  if(status==='completed')send({method:'item/completed',params:{threadId:'thread_1',turnId,item:{type:'agentMessage',phase:'final_answer',text:'fixture answer'}}});
  send({method:'turn/completed',params:{threadId:'thread_1',turn:{id:turnId,status,...(scenario.includes('rate-limit')?{error:{codexErrorInfo:'usageLimitExceeded',message:'limited'}}:{})}}});
}
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  const message=JSON.parse(line);appendFileSync(log,line+'\n');
  if(codex) {
    if(!message.method)return;
    const response=result=>send({id:message.id,result});
    switch(message.method) {
      case 'initialize':response({});break;
      case 'account/read':response({account:{type:'chatgpt'}});break;
      case 'config/read':response({config:{approvals_reviewer:'auto_review',approval_policy:'on-request',sandbox_mode:'workspace-write',developer_instructions:'Existing user instructions.'}});break;
      case 'model/list':response({data:[{model:'gpt-6.10-sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});break;
      case 'thread/start':case 'thread/resume':
        model=message.params.model;response({thread:{id:'thread_1'},model:scenario.includes('mismatch')?'wrong-model':model,approvalsReviewer:'auto_review',approvalPolicy:'on-request',sandbox:{type:'workspaceWrite'},reasoningEffort:message.params.config.model_reasoning_effort??'high'});break;
      case 'turn/start':
        send({method:'turn/started',params:{threadId:'thread_1',turn:{id:turnId}}});response({turn:{id:turnId}});
        if(scenario.includes('question'))send({id:101,method:'item/tool/requestUserInput',params:{threadId:'thread_1',questions:[{question:'Which database?'}]}});
        else if(scenario.includes('rate-limit'))codexEnd('failed');else if(!scenario.includes('steer'))codexEnd();break;
      case 'turn/steer':response({});codexEnd();break;
      case 'turn/interrupt':codexEnd('interrupted');response({});break;
    }
  } else {
    if(message.type==='control_response')return;
    if(message.type==='control_request') {
      const response=value=>send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:value}});
      switch(message.request.subtype) {
        case 'initialize':response({models:[{value:'opus',resolvedModel:'claude-opus-5-5',supportsAutoMode:true,supportedEffortLevels:['low','medium','high','xhigh']}],claude_code_version:'fixture 1.0'});break;
        case 'set_permission_mode':response({});break;
        case 'get_settings':response({applied:{model:scenario.includes('mismatch')?'wrong-model':model,effort:parameter('--effort')||'high'}});break;
        case 'interrupt':response({});send({type:'result',is_error:true,result:'interrupted'});break;
      }
    } else if(message.type==='user') {
      send({type:'system',subtype:'init',session_id:'claude_session_1',model,permissionMode:'auto'});
      if(scenario.includes('auth-error')){send({type:'assistant',error:'authentication_failed',message:{content:[]}});send({type:'result',is_error:true,result:'authentication failed'});return;}
      send({type:'result',is_error:false,result:'fixture answer',modelUsage:{[model]:{}}});
    }
  }
});
