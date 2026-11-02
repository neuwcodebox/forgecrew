import { hash } from './hash.ts';

const suffix = /\n\n<!-- forgecrew:managed:start -->\n[\s\S]*?\n<!-- forgecrew:managed:end -->\n<!-- forgecrew:delivery=[a-zA-Z0-9_-]+ -->\s*$/;
export function deliveryMarker(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid delivery ID');
  return `<!-- forgecrew:delivery=${id} -->`;
}
export function renderOutput(raw: string, attribution: string, id: string): { body: string; bodyHash: string } {
  let body = raw.replace(suffix, '').trimEnd();
  // Close a trailing HTML comment and Markdown fence before adding visible attribution.
  const open = body.lastIndexOf('<!--');
  if (open > body.lastIndexOf('-->')) body += '\n-->';
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!fence) fence = { char: m[1]![0]!, length: m[1]!.length };
    else if (m[1]![0] === fence.char && m[1]!.length >= fence.length && !m[2]!.trim()) fence = null;
  }
  if (fence) body += '\n' + fence.char.repeat(fence.length);
  body += '\n\n<!-- forgecrew:managed:start -->\n' + attribution.trim() + '\n<!-- forgecrew:managed:end -->\n' + deliveryMarker(id);
  return { body, bodyHash: hash(body) };
}
export function splitOutput(raw: string, attribution: string, rootId: string, maxLength = 60000): { id: string; body: string; bodyHash: string }[] {
  const budget = maxLength - renderOutput('', attribution, rootId + '_9999').body.length - 32;
  if (budget < 128) throw new Error('attribution exceeds output budget');
  const points = Array.from(raw);
  const result: { id: string; body: string; bodyHash: string }[] = [];
  // Budget UTF-16 units (conservative for GitHub), never split a surrogate pair.
  let part = ''; let length = 0;
  for (const point of points) {
    if (length + point.length > budget) {
      const id = rootId + '_' + result.length; result.push({ id, ...renderOutput(part, attribution, id) }); part = ''; length = 0;
    }
    part += point; length += point.length;
  }
  const id = rootId + '_' + result.length; result.push({ id, ...renderOutput(part, attribution, id) });
  return result;
}
