import type { LaunchSpec } from './adapters/types.js';
import type { Context } from './context.js';
import { shellQuote } from './env.js';
import { listProcesses } from './relaunch-watch.js';

/**
 * With several copies of an app running (one per profile), `open -a` always goes to the oldest one,
 * whichever profile was asked for. So an app profile is opened like this instead: if its own copy is
 * running, bring that process forward; otherwise start a new copy (`open -n`).
 */

/** The copy a launch would duplicate: the app's main process on `dataDir`, or with no --user-data-dir (the default). */
export interface AppInstance {
  app: string;
  dataDir?: string;
}

const DIR_ARG = ' --user-data-dir=';

/** Whether a `ps` command line is this instance's main process. ps joins arguments with spaces, so the folder must end the line or be followed by another option. */
export function isInstance(args: string, inst: AppInstance): boolean {
  if (!args.startsWith(`${inst.app}/Contents/MacOS/`)) return false;
  if (inst.dataDir === undefined) return !args.includes(DIR_ARG);
  const needle = `${DIR_ARG}${inst.dataDir}`;
  for (let i = args.indexOf(needle); i >= 0; i = args.indexOf(needle, i + 1)) {
    const rest = args.slice(i + needle.length);
    if (rest === '' || rest.startsWith(' --')) return true;
  }
  return false;
}

/**
 * Activates the process and sends it the "reopen" event a Dock click sends, so an app whose windows
 * were closed shows one again. Fails (exit 1) when the process is gone.
 */
const FOCUS_JXA = [
  "ObjC.import('AppKit');",
  'function run(argv) {',
  '  const pid = Number(argv[0]);',
  '  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);',
  "  if (!app.js || app.terminated) throw new Error('gone');",
  '  app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps);',
  '  const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);',
  '  $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x61657674, 0x72617070, target, -1, 0)',
  '    .sendEventWithOptionsTimeoutError(1, 5, null);',
  '}',
].join('\n');

const OSASCRIPT = '/usr/bin/osascript';

export async function findInstance(ctx: Context, inst: AppInstance): Promise<number | undefined> {
  return (await listProcesses(ctx)).find((p) => isInstance(p.args, inst))?.pid;
}

/** Bring the profile's running copy forward, or launch it. Returns whether an existing copy was used. */
export async function openOrFocus(ctx: Context, spec: LaunchSpec): Promise<boolean> {
  if (spec.instance) {
    const pid = await findInstance(ctx, spec.instance);
    if (pid !== undefined && (await ctx.sys.run(OSASCRIPT, ['-l', 'JavaScript', '-e', FOCUS_JXA, String(pid)])).code === 0) return true;
  }
  const r = await ctx.sys.run(spec.command, spec.args, { env: spec.env });
  if (r.code !== 0) throw new Error(`Launch failed: ${r.stderr.trim()}`);
  return false;
}

/** The same, as bash for a launcher .app (which runs without Node). Mirrors isInstance. */
export function openOrFocusScript(spec: LaunchSpec): string {
  const open = `exec ${[spec.command, ...spec.args].map(shellQuote).join(' ')}`;
  if (!spec.instance) return `#!/bin/bash\n${open}\n`;
  const { app, dataDir } = spec.instance;
  const awk = [
    '{ pid = $1; sub(/^ *[0-9]+ +/, "")',
    '  if (index($0, pre) != 1) next',
    `  if (dir == "") { if (index($0, "${DIR_ARG}") == 0) { print pid; exit } ; next }`,
    `  s = $0; n = "${DIR_ARG}" dir`,
    '  while ((i = index(s, n)) > 0) { r = substr(s, i + length(n)); if (r == "" || substr(r, 1, 3) == " --") { print pid; exit }; s = substr(s, i + 1) } }',
  ].join('\n');
  return [
    '#!/bin/bash',
    '# Bring this profile\'s running copy forward; `open -a` would pick the oldest copy of the app.',
    `pid=$(/bin/ps -axww -o pid=,args= | /usr/bin/awk -v pre=${shellQuote(`${app}/Contents/MacOS/`)} -v dir=${shellQuote(dataDir ?? '')} ${shellQuote(awk)})`,
    `[ -n "$pid" ] && ${OSASCRIPT} -l JavaScript -e ${shellQuote(FOCUS_JXA)} "$pid" >/dev/null 2>&1 && exit 0`,
    open,
    '',
  ].join('\n');
}
