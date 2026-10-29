import type { AihubApi } from '../../main/index';
import type { UpdateStatus } from '../../main/updater';

type Promised<F> = F extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
export type Api = { [K in keyof AihubApi]: Promised<AihubApi[K]> } & {
  onUpdate(cb: (status: UpdateStatus) => void): () => void;
};
export type { UpdateStatus };

export const api = (window as unknown as { aihub: Api }).aihub;

/** "Error invoking remote method 'aihub:x': Error: message" → "message" */
export const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export type ProfileView = Awaited<ReturnType<Api['profiles']>>[number];
export type Matrix = Awaited<ReturnType<Api['matrix']>>;
export type Plan = Awaited<ReturnType<Api['setShare']>>;
export type DoctorReport = Awaited<ReturnType<Api['doctor']>>;
export type Candidate = Awaited<ReturnType<Api['discover']>>[number];
export type RemovalInfo = Awaited<ReturnType<Api['removalInfo']>>;
