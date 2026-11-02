import { workerVersion } from './version.ts';
import { command, spawnProcess } from './process.ts';
import { RpcClient } from './rpc.ts';
import { DispatcherClient } from './client.ts';
import type { LocalConfig } from './local.ts';

export type Diagnostic={component:string;status:'ok'|'blocked';detail:string};
export async function doctor(config:LocalConfig):Promise<Diagnostic[]> {
  const checks:Diagnostic[]=[];
  const check=async (component:string,run:()=>Promise<string>) => {
    try {checks.push({component,status:'ok',detail:await run()});}
    catch {checks.push({component,status:'blocked',detail:component==='dispatcher'?'Dispatcher 주소·TLS·Worker 등록 상태를 확인하세요.':'실행 파일·호스트별 로그인·지원 버전을 확인하세요.'});}
  };
  await check('node',async () => {
    const [major,minor]=process.versions.node.split('.').map(Number);
    if(major!==24||(minor??0)<11)throw new Error('node_version');return process.versions.node;
  });
  await check('npm',async()=>{const r=await command('npm',['--version']);if(r.code!==0)throw new Error();return r.stdout.trim();});
  await check('git',async () => {const r=await command('git',['--version']);if(r.code!==0)throw new Error();return r.stdout.trim();});
  await check('github',async () => {
    const r=await command('gh',['api','--hostname',config.hostname,'user','--jq','{login: .login, id: .id}']);
    if(r.code!==0)throw new Error();const user=JSON.parse(r.stdout) as {login:string;id:number};if(!user.login||!user.id)throw new Error();
    return `${config.hostname}: ${user.login}`;
  });
  await check('dispatcher',async()=>{const status=await new DispatcherClient(config).request<{configRevision:string;sessions:unknown[]}>('/v1/status',undefined,{method:'GET',timeout:5000});return 'revision '+status.configRevision+' · sessions '+status.sessions.length;});
  if(config.engines.codex)await check('codex',async () => {
    const rpc=new RpcClient(spawnProcess(config.engines.codex!,['app-server']));
    try {
      await rpc.request('initialize',{clientInfo:{name:'forgecrew',version:workerVersion},capabilities:{experimentalApi:true}});rpc.notify('initialized');
      const account=await rpc.request<{account:{type:string}|null}>('account/read',{refreshToken:false});
      if(!account.account||account.account.type==='apiKey')throw new Error('subscription_login_required');
      const models=await rpc.request<{data:unknown[]}>('model/list',{limit:100,includeHidden:false});
      return `구독 로그인 확인 · 모델 ${models.data.length}개 (실제 실행·자동 검토 시험은 별도)`;
    } finally {await rpc.close();}
  });
  if(config.engines.claude)await check('claude',async () => {
    const result=await command(config.engines.claude!,['auth','status']);
    if(result.code!==0)throw new Error();const auth=JSON.parse(result.stdout) as {loggedIn?:boolean;authMethod?:string};
    if(!auth.loggedIn||!['claude.ai','oauth_token'].includes(auth.authMethod??''))throw new Error('subscription_login_required');
    const help=await command(config.engines.claude!,['--help']);
    for(const flag of ['--permission-mode','--permission-prompts','--system-prompt-snapshot','--append-system-prompt-file'])if(!help.stdout.includes(flag))throw new Error('runtime_update_required');
    return '구독 로그인·필수 CLI 옵션 확인 (모델·자동 검토 실제 실행 시험은 별도)';
  });
  return checks;
}
