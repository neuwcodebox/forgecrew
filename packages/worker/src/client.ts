import type { LocalConfig } from './local.ts';

export class DispatcherError extends Error {
  readonly status:number;
  constructor(status:number) {super('dispatcher_http_'+status);this.status=status;}
}
export class DispatcherClient {
  readonly config:LocalConfig;
  readonly fetcher:typeof fetch;
  requestTimeout=30000;
  constructor(config:LocalConfig,fetcher:typeof fetch=fetch) {
    const url=new URL(config.dispatcher);
    if(url.username||url.password||url.search||url.hash)throw new Error('invalid_dispatcher_url');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('dispatcher_requires_tls');
    this.config=config;this.fetcher=fetcher;
  }
  async request<T>(path:string,body?:unknown,options:{method?:string;registrationToken?:string;timeout?:number;signal?:AbortSignal}={}):Promise<T> {
    const response=await this.fetcher(this.config.dispatcher.replace(/\/$/,'')+path,{
      method:options.method??'POST',redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(options.timeout??this.requestTimeout)]):AbortSignal.timeout(options.timeout??this.requestTimeout),
      headers:{'Content-Type':'application/json','X-ForgeCrew-Worker':this.config.id,Authorization:'Bearer '+(options.registrationToken??this.config.token)},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    if(!response.ok)throw new DispatcherError(response.status);
    return await response.json() as T;
  }
}
