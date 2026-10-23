import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createContext, type Context, type Env, type RunResult, type System } from '../src/context.js';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

export async function tempHome(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aihub-test-')));
  made.push(dir);
  return dir;
}

export async function write(file: string, content = ''): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

export async function executable(file: string): Promise<string> {
  await write(file, '#!/bin/sh\n');
  await fs.chmod(file, 0o755);
  return file;
}

export interface FakeSystem extends System {
  calls: { cmd: string; args: string[]; env?: Env }[];
}

export function fakeSystem(
  opts: { keychain?: string[]; run?: (cmd: string, args: string[], env?: Env) => Partial<RunResult> } = {},
): FakeSystem {
  const calls: FakeSystem['calls'] = [];
  return {
    platform: 'darwin',
    calls,
    async run(cmd, args, o) {
      calls.push({ cmd, args, env: o?.env });
      return { code: 0, stdout: '', stderr: '', ...opts.run?.(cmd, args, o?.env) };
    },
    async runInteractive(cmd, args, env) {
      calls.push({ cmd, args, env });
      return 0;
    },
    async keychainHasService(service) {
      return opts.keychain?.includes(service) ?? false;
    },
  };
}

export function ctxFor(home: string, sys: System = fakeSystem(), env: Env = {}): Context {
  return createContext({ HOME: home, PATH: path.join(home, 'bin'), AIHUB_HOME: path.join(home, '.aihub'), ...env }, sys);
}
