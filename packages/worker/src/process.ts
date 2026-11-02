import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

export type CommandResult = { code: number | null; stdout: string; stderr: string };
export function spawnProcess(executable: string, args: string[], cwd?: string): ChildProcessWithoutNullStreams {
  // No shell interpolation; retain the user's PATH, HOME, proxy and certificate settings.
  const child=spawn(executable,args,{ ...(cwd ? {cwd} : {}),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'] }) as ChildProcessWithoutNullStreams;
  child.once('spawn',()=>{if(process.connected)process.send?.({type:'CHILD_SPAWN',protocolVersion:1,pid:child.pid});});
  child.once('close',()=>{if(process.connected)process.send?.({type:'CHILD_EXIT',protocolVersion:1,pid:child.pid});});
  return child;
}
export async function terminateTree(child: ChildProcessWithoutNullStreams, grace = 1000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child,'close').then(() => true);
  const signal = (force: boolean) => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T',...(force?['/F']:[])],{windowsHide:true,stdio:'ignore'});
      killer.on('error',() => {});
    } else {
      try { process.kill(-child.pid,force?'SIGKILL':'SIGTERM'); } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ESRCH') throw e; }
    }
  };
  signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!await Promise.race([closed,new Promise<boolean>(r => {timer=setTimeout(() => r(false),grace);})])) {
    signal(true);
    await Promise.race([closed,new Promise((_,reject) => {timer=setTimeout(() => reject(new Error('process_tree_did_not_exit')),grace);})]).finally(() => clearTimeout(timer));
  }
  clearTimeout(timer);
}
export async function command(executable: string,args: string[],options: {cwd?:string;input?:string;timeout?:number;maxBytes?:number;signal?:AbortSignal} = {}): Promise<CommandResult> {
  if(options.signal?.aborted)throw new Error('command_cancelled');
  const child=spawnProcess(executable,args,options.cwd);let stdout='';let stderr='';let size=0;
  const max=options.maxBytes??4*1024*1024;
  let rejectRun: (error:Error) => void = () => {};
  let failure: Error | undefined;
  const fail=(error:Error) => { if (failure) return; failure=error; void terminateTree(child).catch(() => {}).finally(() => rejectRun(error)); };
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  const take=(chunk:string,isError:boolean) => {size+=Buffer.byteLength(chunk);if(size>max) {fail(new Error('command_output_limit'));return;}if(isError)stderr+=chunk;else stdout+=chunk;};
  child.stdout.on('data',d => take(d,false));child.stderr.on('data',d => take(d,true));
  const timeout=setTimeout(() => fail(new Error('command_timeout')),options.timeout??15000);
  const abort=()=>fail(new Error('command_cancelled'));options.signal?.addEventListener('abort',abort,{once:true});
  try {
    return await new Promise<CommandResult>((resolve,reject) => {
      rejectRun=reject;child.once('error',() => reject(new Error('executable_unavailable')));
      child.once('close',code => {if(failure)reject(failure);else resolve({code,stdout,stderr});});
      child.stdin.on('error',() => {});child.stdin.end(options.input??'');
    });
  } finally {clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
}
