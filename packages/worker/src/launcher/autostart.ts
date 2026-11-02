import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { command } from '../process.ts';

export function linuxUnit(node:string,directory:string,path:string) {
  const quote=(s:string)=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('\n','\\n')+'"';
  const execQuote=(s:string)=>quote(s.replaceAll('$','$$'));
  return `[Unit]\nDescription=ForgeCrew user Worker\n\n[Service]\nType=simple\nExecStart=${execQuote(node)} ${execQuote(join(directory,'launcher.mjs'))} ${execQuote(directory)}\nEnvironment=${quote('PATH='+path)}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n`;
}
export function windowsTaskScript(node:string,directory:string,name:string,enabled:boolean) {
  const ps=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  if(!enabled)return `Unregister-ScheduledTask -TaskName ${ps(name)} -Confirm:$false -ErrorAction SilentlyContinue`;
  const args='"'+join(directory,'launcher.mjs')+'" "'+directory+'"';
  return `$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(args)}; $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user; $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); Register-ScheduledTask -TaskName ${ps(name)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`;
}
export async function setAutostart(directory:string,enabled:boolean) {
  const name='forgecrew-'+createHash('sha256').update(directory).digest('hex').slice(0,12);
  if(process.platform==='win32') {
    const script=windowsTaskScript(process.execPath,directory,name,enabled);
    const r=await command('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
    if(r.code!==0)throw new Error('autostart_registration_failed');
  } else if(process.platform==='linux') {
    const root=join(process.env.XDG_CONFIG_HOME??join(homedir(),'.config'),'systemd','user');const unit=name+'.service';
    await mkdir(root,{recursive:true});
    if(enabled)await writeFile(join(root,unit),linuxUnit(process.execPath,directory,process.env.PATH??''),{mode:0o600});
    else {const r=await command('systemctl',['--user','disable',unit]);if(r.code!==0)throw new Error('autostart_registration_failed');await unlink(join(root,unit)).catch(()=>{});}
    const reload=await command('systemctl',['--user','daemon-reload']);if(reload.code!==0)throw new Error('user_service_manager_unavailable');
    if(enabled){const r=await command('systemctl',['--user','enable',unit]);if(r.code!==0)throw new Error('autostart_registration_failed');}
  } else throw new Error('unsupported_autostart_platform');
}
