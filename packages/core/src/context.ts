import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultHome, resolvePath } from './paths.js';

export type Env = Record<string, string | undefined>;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything that touches the OS beyond plain file reads goes through here, so tests can fake it. */
export interface System {
  platform: NodeJS.Platform;
  run(cmd: string, args: string[], opts?: { env?: Env; timeoutMs?: number }): Promise<RunResult>;
  /** Launch with the terminal attached; resolves to the exit code. */
  runInteractive(cmd: string, args: string[], env: Env): Promise<number>;
  /** True when a generic-password item with this service name exists. Never reads the secret. */
  keychainHasService(service: string): Promise<boolean>;
}

export interface Context {
  home: string;
  /** ~/.aihub, or $AIHUB_HOME. */
  hubDir: string;
  env: Env;
  sys: System;
}

export const realSystem: System = {
  platform: process.platform,

  run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs ?? 15_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err) }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },

  runInteractive(cmd, args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  },

  async keychainHasService(service) {
    if (process.platform !== 'darwin') return false;
    // Without -w/-g, `security` prints only item attributes; we discard even those.
    const r = await realSystem.run('/usr/bin/security', ['find-generic-password', '-s', service]);
    return r.code === 0;
  },
};

export function createContext(env: Env = process.env, sys: System = realSystem): Context {
  const home = defaultHome(env as NodeJS.ProcessEnv);
  const hubDir = env.AIHUB_HOME ? resolvePath(env.AIHUB_HOME, home) : path.join(home, '.aihub');
  return { home, hubDir, env, sys };
}

/** First executable named `cmd` on PATH, then any fallback locations. */
export async function findExecutable(
  ctx: Context,
  cmd: string,
  fallbacks: string[] = [],
): Promise<string | undefined> {
  const dirs = (ctx.env.PATH ?? '').split(':').filter(Boolean);
  for (const candidate of [...dirs.map((d) => path.join(d, cmd)), ...fallbacks]) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
