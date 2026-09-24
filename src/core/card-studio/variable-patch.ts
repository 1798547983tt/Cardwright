/**
 * JSON Patch the way MVU applies the model's <JSONPatch> (RFC 6902): replace and remove need the path to exist,
 * add needs its parent to exist (a new record item is added whole, then its fields can be replaced), `-` appends
 * to a list. Runs on a copy; the first failing operation stops it.
 */
export interface PatchOperation { op: string; path: string; from?: string; value?: unknown }
export interface PatchResult { ok: boolean; value: unknown; error?: string }

type Holder = Record<string, unknown> | unknown[];
interface Slot { holder: Holder; key: string }

const clone = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const segments = (path: string): string[] => path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
const isHolder = (value: unknown): value is Holder => !!value && typeof value === 'object';

/** The container and key a pointer names; every container on the way must already exist. */
function locate(root: unknown, path: string): Slot | string {
  const parts = segments(path);
  if (!parts.length || parts.some(part => part === '')) return `路径 ${path || '(空)'} 不合法。`;
  let current: unknown = root;
  for (const [index, part] of parts.slice(0, -1).entries()) {
    const here = `/${parts.slice(0, index + 1).join('/')}`;
    if (!isHolder(current)) return `${here} 的上级不是容器。`;
    if (Array.isArray(current)) {
      const at = Number(part);
      if (!Number.isInteger(at) || at < 0 || at >= current.length) return `${here} 不存在。`;
      current = current[at]; continue;
    }
    if (!Object.hasOwn(current, part)) return `${here} 不存在。`;
    current = current[part];
  }
  if (!isHolder(current)) return `${path} 的上级不是容器。`;
  return { holder: current, key: parts.at(-1)! };
}
const exists = (slot: Slot): boolean => (Array.isArray(slot.holder)
  ? slot.key !== '-' && Number.isInteger(Number(slot.key)) && Number(slot.key) >= 0 && Number(slot.key) < slot.holder.length
  : Object.hasOwn(slot.holder, slot.key));
const readAt = (slot: Slot): unknown => (Array.isArray(slot.holder) ? slot.holder[Number(slot.key)] : slot.holder[slot.key]);
function removeAt(slot: Slot): void { if (Array.isArray(slot.holder)) slot.holder.splice(Number(slot.key), 1); else delete slot.holder[slot.key]; }
/** add inserts into a list (`-` appends) and sets a member; replace overwrites in place. */
function writeAt(slot: Slot, value: unknown, insert: boolean): string | null {
  if (!Array.isArray(slot.holder)) { slot.holder[slot.key] = value; return null; }
  if (slot.key === '-') { if (!insert) return '列表末尾 - 只能用于 add。'; slot.holder.push(value); return null; }
  const at = Number(slot.key);
  if (!Number.isInteger(at) || at < 0 || at > slot.holder.length || (!insert && at === slot.holder.length)) return `列表下标 ${slot.key} 越界。`;
  if (insert) slot.holder.splice(at, 0, value); else slot.holder[at] = value;
  return null;
}

export function applyJsonPatch(initial: unknown, operations: PatchOperation[]): PatchResult {
  if (!Array.isArray(operations)) return { ok: false, value: clone(initial) ?? {}, error: 'JSONPatch 必须是一个数组。' };
  const value = clone(initial) ?? {};
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== 'object') return { ok: false, value, error: `第 ${index + 1} 条不是对象。` };
    const label = `第 ${index + 1} 条（${String(operation.op)} ${String(operation.path)}）`;
    if (!['add', 'replace', 'remove', 'move'].includes(operation.op)) return { ok: false, value, error: `${label}：op 只能是 add、replace、remove、move。` };
    if (typeof operation.path !== 'string' || !operation.path.startsWith('/')) return { ok: false, value, error: `${label}：path 要以 / 开头。` };
    if (operation.op === 'move') {
      if (typeof operation.from !== 'string') return { ok: false, value, error: `${label}：move 需要 from。` };
      const source = locate(value, operation.from);
      if (typeof source === 'string') return { ok: false, value, error: `${label}：${source}` };
      if (!exists(source)) return { ok: false, value, error: `${label}：${operation.from} 不存在。` };
      const moved = readAt(source);
      removeAt(source);
      const target = locate(value, operation.path);
      if (typeof target === 'string') return { ok: false, value, error: `${label}：${target}` };
      const problem = writeAt(target, moved, true);
      if (problem) return { ok: false, value, error: `${label}：${problem}` };
      continue;
    }
    const slot = locate(value, operation.path);
    if (typeof slot === 'string') return { ok: false, value, error: `${label}：${slot}` };
    if (operation.op === 'remove') {
      if (!exists(slot)) return { ok: false, value, error: `${label}：remove 的路径不存在。` };
      removeAt(slot); continue;
    }
    if (!('value' in operation)) return { ok: false, value, error: `${label}：缺少 value。` };
    if (operation.op === 'replace' && !exists(slot)) return { ok: false, value, error: `${label}：replace 的路径不存在，新增要用 add。` };
    const problem = writeAt(slot, clone(operation.value), operation.op === 'add');
    if (problem) return { ok: false, value, error: `${label}：${problem}` };
  }
  return { ok: true, value };
}
