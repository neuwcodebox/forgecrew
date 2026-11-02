import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminateTree } from './process.ts';

export type RpcNotification = { method: string; params: Record<string,unknown>; id?: number | string };
export class RpcClient extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly timeout: number;
  private nextId=0;
  private pending=new Map<number,{resolve:(v:unknown) => void;reject:(e:Error) => void;timer:ReturnType<typeof setTimeout>}>();
  private terminal=false;
  constructor(child:ChildProcessWithoutNullStreams,timeout=15000) {
    super();this.child=child;this.timeout=timeout;
    // Drain diagnostics but never forward full stderr, which may include prompts or credentials.
    child.stderr.resume();
    const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
    lines.on('line',line => {
      if (line.length>8*1024*1024) {this.fail(new Error('rpc_message_too_large'));return;}
      try {
        const m=JSON.parse(line) as {id?:number|string;result?:unknown;error?:unknown;method?:string;params?:Record<string,unknown>};
        if (m.method) this.emit('notification',{method:m.method,params:m.params??{},...(m.id===undefined?{}:{id:m.id})});
        else if (typeof m.id==='number') {
          const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
          if(m.error)p.reject(new Error('rpc_request_rejected'));else p.resolve(m.result);
        }
      } catch {this.fail(new Error('invalid_rpc_json'));}
    });
    child.on('error',() => this.fail(new Error('runtime_unavailable')));
    child.on('close',() => {lines.close();this.fail(new Error('runtime_exited'));});
    child.stdin.on('error',() => this.fail(new Error('runtime_input_closed')));
  }
  private fail(error:Error) {
    if(this.terminal)return;this.terminal=true;
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    this.emit('closed',error);
  }
  request<T=unknown>(method:string,params:Record<string,unknown>={}):Promise<T> {
    if(this.terminal)return Promise.reject(new Error('rpc_closed'));
    const id=++this.nextId;
    return new Promise<T>((resolve,reject) => {
      const timer=setTimeout(() => {this.pending.delete(id);reject(new Error('rpc_timeout'));},this.timeout);
      this.pending.set(id,{resolve:v => resolve(v as T),reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n',error => {if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('rpc_write_failed'));}});
    });
  }
  notify(method:string,params?:Record<string,unknown>) { this.child.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n'); }
  async close() {this.fail(new Error('rpc_closed'));await terminateTree(this.child);}
}
