import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';

export const VersionSchema=z.strictObject({formatVersion:z.literal(1),id:z.string().regex(/^[a-zA-Z0-9._-]+$/),version:z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),entry:z.string().min(1),integrity:z.string().min(1),launcherProtocol:z.literal(1),stateSchema:z.literal(1)});
export type InstalledVersion=z.infer<typeof VersionSchema>;
export async function installedVersion(directory:string,id:string):Promise<InstalledVersion> {
  if(!/^[a-zA-Z0-9._-]+$/.test(id))throw new Error('invalid_version_id');
  const root=await realpath(join(directory,'versions',id));
  const manifest=VersionSchema.parse(JSON.parse(await readFile(join(root,'installed.json'),'utf8')));
  const entry=await realpath(join(root,manifest.entry));const rel=relative(root,entry);
  if(manifest.id!==id||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+'/')||rel.startsWith('..'+'\\'))throw new Error('invalid_version_entry');
  return manifest;
}
