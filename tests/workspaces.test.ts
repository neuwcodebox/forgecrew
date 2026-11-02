import { afterEach,describe,expect,it } from 'vitest';
import { mkdtemp,mkdir,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GhClient } from '../packages/worker/src/github.ts';
import { command } from '../packages/worker/src/process.ts';
import { sessionId } from '../packages/shared/src/hash.ts';
import type { WorkSession } from '../packages/shared/src/protocol.ts';

const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function dir(){const root=await mkdtemp(join(tmpdir(),'forgecrew-workspace-'));directories.push(root);return root;}
async function git(args:string[],cwd?:string){const result=await command('git',args,{...(cwd?{cwd}:{}),timeout:30000});if(result.code!==0)throw new Error('fixture_git_failed: '+result.stderr);return result.stdout.trim();}
function session(number:number):WorkSession {const key={host:'github.example.internal',repository:'team/project-a',kind:'issue' as const,number};return {...key,id:sessionId(key)};}
describe('managed Git workspaces',{timeout:30000},()=>{
  it('keeps two clones of the same branch independent and preserves dirty state and local Git settings',async()=>{
    const root=await dir(),origin=join(root,'origin.git'),seed=join(root,'seed');await git(['init','--bare',origin]);await git(['init','--initial-branch=main',seed]);
    await writeFile(join(seed,'tracked.txt'),'original\n');await git(['add','tracked.txt'],seed);
    await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture'],seed);
    await git(['push',origin,'main'],seed);await git(['--git-dir',origin,'symbolic-ref','HEAD','refs/heads/main']);
    const calls:string[][]=[];
    const gh=new GhClient(session(1).host,async(executable,args,options)=>{
      calls.push([executable,...args]);
      if(executable==='gh'&&args[0]==='repo'&&args[1]==='clone')return command('git',['clone','--no-hardlinks',origin,args.at(-1)!],options);
      return command(executable,args,options);
    });
    const a=await gh.workspace(root,session(1)),b=await gh.workspace(root,session(2));expect(a).not.toBe(b);
    await writeFile(join(a,'tracked.txt'),'local changes\n');await writeFile(join(a,'untracked.txt'),'keep me');
    await git(['config','user.name','Local coworker'],a);await git(['config','commit.gpgsign','true'],a);
    expect(await gh.workspace(root,session(1))).toBe(a);expect(await readFile(join(a,'tracked.txt'),'utf8')).toBe('local changes\n');expect(await readFile(join(a,'untracked.txt'),'utf8')).toBe('keep me');
    expect((await readFile(join(b,'tracked.txt'),'utf8')).replace(/\r\n/g,'\n')).toBe('original\n');expect(await git(['config','user.name'],a)).toBe('Local coworker');expect(await git(['config','commit.gpgsign'],a)).toBe('true');
    expect(calls.filter(c=>c[0]==='gh')).toHaveLength(2);expect(calls.some(c=>c.includes('reset')||c.includes('clean'))).toBe(false);
  });
  it('rejects a checkout redirected outside the managed root',async()=>{
    const root=await dir(),outside=await dir(),s=session(1);await mkdir(join(root,'workspaces'));await symlink(outside,join(root,'workspaces',s.id),process.platform==='win32'?'junction':'dir');
    await expect(new GhClient(s.host).workspace(root,s)).rejects.toThrow('workspace_outside_managed_root');
  });
});
