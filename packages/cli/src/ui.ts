import { styleText } from 'node:util';
import {
  ITEM_KINDS,
  adapterFor,
  contractHome,
  createContext,
  parseShareKind,
  type Action,
  type Finding,
  type Identity,
  type ItemKind,
  type Plan,
  type Profile,
} from '@aihub/core';

export const ctx = createContext();


export type Style = Parameters<typeof styleText>[0];
export const paint = (style: Style, s: string) => styleText(style, s);
export const dim = (s: string) => paint('dim', s);

export function table(head: string[], rows: string[][]): string {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => c + ' '.repeat(widths[i]! - strip(c).length)).join('  ').trimEnd();
  return [paint('bold', line(head)), ...rows.map(line)].join('\n');
}

export function who(id: Identity | undefined): string {
  if (!id) return '';
  if (id.status === 'signed-in') return paint('green', id.email ?? id.detail ?? 'signed in');
  if (id.status === 'signed-out') return paint('yellow', 'not signed in');
  return dim(id.detail ?? 'unknown');
}

export const folderOf = (p: Profile) => contractHome(adapterFor(p).paths(ctx, p).root, ctx.home);
export const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export const MARK: Record<Finding['level'], string> = {
  ok: paint('green', '✓'),
  info: paint('blue', '·'),
  warn: paint('yellow', '⚠'),
  error: paint('red', '✗'),
};

export const STATUS: Record<Action['status'], (s: string) => string> = {
  done: (s) => paint('green', `✓ ${s}`),
  ok: (s) => dim(`· ${s}`),
  pending: (s) => paint('yellow', `→ ${s}`),
  blocked: (s) => paint('yellow', `⏸ ${s}`),
  conflict: (s) => paint('yellow', `⚠ ${s}`),
  unsupported: (s) => dim(`– ${s}`),
  failed: (s) => paint('red', `✗ ${s}`),
};

export function printActions(actions: Action[], indent = '  ') {
  for (const a of actions) {
    const what = `${a.kind.replace(/s$/, '')} ${a.name}${a.type === 'remove' || a.type === 'uninstall-plugin' ? ' (remove)' : ''}`;
    const tag = a.status === 'pending' ? ` ${dim(a.type)}` : a.status === 'ok' ? '' : ` ${dim(a.status)}`;
    console.log(`${indent}${STATUS[a.status](what)}${tag}${a.reason ? dim(`: ${a.reason}`) : ''}`);
  }
}

export function printPlans(plans: (Plan & { error?: string })[], dryRun?: boolean) {
  for (const plan of plans) {
    if (!plan.actions.length && !plan.error) continue;
    console.log(paint('bold', plan.profile));
    if (plan.error) console.log(paint('red', `  ✗ ${plan.error}`));
    printActions(plan.actions);
  }
  const all = plans.flatMap((p) => p.actions);
  const count = (st: Action['status']) => all.filter((a) => a.status === st).length;
  const parts = dryRun
    ? [`${count('pending')} to change`, `${count('ok')} already in place`]
    : [`${count('done')} changed`, `${count('ok')} already in place`];
  for (const st of ['blocked', 'conflict', 'failed'] as const) if (count(st)) parts.push(`${count(st)} ${st}`);
  console.log(dim(`\n${parts.join(' · ')}${dryRun ? ' (dry run)' : ''}`));
  if (all.some((a) => a.status === 'failed') || plans.some((p) => p.error)) process.exitCode = 1;
}

export const itemKind = (s: string): ItemKind => {
  const k = parseShareKind(s);
  if (!(ITEM_KINDS as readonly string[]).includes(k)) throw new Error(`Use one of: ${ITEM_KINDS.join(', ')}.`);
  return k as ItemKind;
};

/** Run an action, turning thrown errors into a one-line message and exit code 1. */
export const action =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(paint('red', `error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  };

