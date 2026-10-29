import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountOf,
  adapterFor,
  addToLibrary,
  appVersion,
  applyImport,
  buildLauncher,
  contractHome,
  createAccount,
  createContext,
  deleteProfile,
  discover,
  doctor,
  getLibraryItem,
  ITEM_KINDS,
  SHARE_KINDS,
  getProfile,
  installedBrowsers,
  isolationFor,
  launcherPath,
  launchProfile,
  listProcesses,
  loadHub,
  mainFile,
  readPlistString,
  reconcile,
  reconcileAll,
  relabelProfile,
  removalInfo,
  renderIcon,
  saveHub,
  setSharing,
  sharingMatrix,
  takeover,
  undoLast,
  UpdateRelaunchWatcher,
  watchTargets,
  withHubLock,
  type ItemKind,
  type NewAccount,
  type Profile,
  type ShareKind,
} from '@aihub/core';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import { API_METHODS } from '../shared/methods';
import { checkForUpdate, downloadAndInstall, installTarget, type Release, type UpdateStatus } from './updater';

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = createContext();
/** Folder to write screenshots of each page to, then quit (used for automated smoke tests). */
const SMOKE = process.env.AIHUB_SMOKE;

/** GitHub repo whose Releases this app updates from. */
const UPDATE_REPO = process.env.AIHUB_UPDATE_REPO ?? 'isacsneto/ai-hub';
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

let updateStatus: UpdateStatus = { state: 'idle', current: app.getVersion() };
let latestRelease: Release | undefined;

function setUpdateStatus(next: UpdateStatus) {
  const changed = next.state !== updateStatus.state;
  updateStatus = next;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('aihub:update', next);
  if (changed) void refreshTray();
}

async function checkUpdates(): Promise<UpdateStatus> {
  if (updateStatus.state === 'downloading' || updateStatus.state === 'installing') return updateStatus;
  const current = app.getVersion();
  setUpdateStatus({ state: 'checking', current });
  try {
    const r = await checkForUpdate(UPDATE_REPO, current);
    latestRelease = r.release;
    const checkedAt = new Date().toISOString();
    setUpdateStatus(
      r.available && r.release
        ? { state: 'available', current, latest: r.latest!, notes: r.release.body ?? '', url: r.release.html_url, checkedAt }
        : r.missingBuild
          ? { state: 'error', current, message: `AI-Hub ${r.latest} is out, but has no build for this Mac (${process.arch}) yet.` }
          : { state: 'up-to-date', current, checkedAt },
    );
  } catch (err) {
    setUpdateStatus({ state: 'error', current, message: (err as Error).message });
  }
  return updateStatus;
}

/** The `aihub` command bundled in this app: it runs with the app's own runtime, so it updates with the app. */
const CLI_SHIM = path.join(ctx.home, '.local/bin/aihub');
const CLI_MARKER = '# Installed by AI-Hub.app';

async function installCli(): Promise<string> {
  const target = installTarget(process.execPath);
  if ('problem' in target) throw new Error(target.problem);
  const existing = await fs.readFile(CLI_SHIM, 'utf8').catch(() => undefined);
  if (existing !== undefined && !existing.includes(CLI_MARKER)) {
    throw new Error(`${contractHome(CLI_SHIM, ctx.home)} exists and wasn't installed by AI-Hub; leaving it alone.`);
  }
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  await fs.mkdir(path.dirname(CLI_SHIM), { recursive: true });
  await fs.writeFile(
    CLI_SHIM,
    [
      '#!/bin/sh',
      `${CLI_MARKER}; runs the CLI inside the app, so it updates with the app.`,
      `APP=${q(target.app)}`,
      'ELECTRON_RUN_AS_NODE=1 exec "$APP/Contents/MacOS/AI-Hub" "$APP/Contents/Resources/app.asar/out/main/cli.js" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return contractHome(CLI_SHIM, ctx.home);
}

/** IPC arguments are only typed at compile time; a kind ends up in a library path, so check it. */
function assertKind(kind: unknown, allowed: readonly string[]): void {
  if (typeof kind !== 'string' || !allowed.includes(kind)) throw new Error(`Unknown kind "${String(kind)}".`);
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

type IconPatch = NonNullable<Profile['icon']>;

/** Everything the window can ask for. Each method is reachable as window.aihub.<name>(). */
const api = {
  async profiles() {
    const hub = await loadHub(ctx);
    return Promise.all(
      hub.profiles.map(async (p) => {
        const adapter = adapterFor(p);
        return {
          profile: p,
          toolName: adapter.displayName,
          identity: await adapter.identity(ctx, p),
          folder: contractHome(adapter.paths(ctx, p).root, ctx.home),
          tested: isolationFor(p),
          account: accountOf(ctx, hub, p),
          launcher: (await fs.stat(launcherPath(ctx, hub, p)).catch(() => undefined)) ? contractHome(launcherPath(ctx, hub, p), ctx.home) : undefined,
        };
      }),
    );
  },

  async icon(id: string, size = 256) {
    return dataUrl(await renderIcon(ctx, getProfile(await loadHub(ctx), id), size));
  },

  /** Render an icon with unsaved edits, for the editor's live preview. */
  async iconPreview(id: string, icon: IconPatch, size = 256) {
    const p = getProfile(await loadHub(ctx), id);
    return dataUrl(await renderIcon(ctx, { ...p, icon: { ...p.icon, ...icon } } as Profile, size));
  },

  async matrix() {
    return sharingMatrix(ctx, await loadHub(ctx));
  },

  async setShare(req: { kind: ShareKind; name: string; profileId: string; on: boolean; allowMcp?: boolean; detach?: boolean; force?: boolean }) {
    assertKind(req?.kind, SHARE_KINDS);
    // Read, change, save and apply as one step, so a quick second click works on the first one's result.
    return withHubLock(ctx, async () => {
      const hub = await loadHub(ctx);
      const [p] = await setSharing(ctx, hub, req.kind, req.name, [req.profileId], req.on, { allowMcp: req.allowMcp });
      await saveHub(ctx, hub);
      return reconcile(ctx, hub, p!, { detach: req.detach, force: req.force });
    });
  },

  async applyAll(opts: { detach?: boolean; force?: boolean } = {}) {
    return reconcileAll(ctx, await loadHub(ctx), opts);
  },

  async undo() {
    return (await undoLast(ctx)) ?? null;
  },

  async doctor() {
    return doctor(ctx, await loadHub(ctx));
  },

  async itemText(kind: ItemKind, name: string) {
    assertKind(kind, ITEM_KINDS);
    return fs.readFile(mainFile(await getLibraryItem(ctx, kind, name)), 'utf8');
  },

  async addLibraryItem(kind: ItemKind) {
    assertKind(kind, ITEM_KINDS);
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions =
      kind === 'skills'
        ? { title: 'Choose a skill folder (with SKILL.md)', properties: ['openDirectory'] }
        : { title: `Choose a ${kind.replace(/s$/, '')} .md file`, properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    const item = await addToLibrary(ctx, kind, res.filePaths[0]);
    return { kind: item.kind, name: item.name };
  },

  async updateProfile(id: string, patch: { label?: string; icon?: IconPatch }) {
    const hub = await loadHub(ctx);
    const p = getProfile(hub, id);
    if (patch.label?.trim()) await relabelProfile(ctx, hub, p, patch.label);
    if (patch.icon) p.icon = { ...p.icon, ...patch.icon };
    await saveHub(ctx, hub);
    refreshTray();
  },

  async installedBrowsers() {
    return installedBrowsers(ctx);
  },

  async newAccount(spec: NewAccount) {
    if (!spec || typeof spec !== 'object' || !['claude', 'codex', 'cursor', 'web'].includes((spec as { kind?: string }).kind ?? '')) {
      throw new Error('Unknown kind of account.');
    }
    const made = await withHubLock(ctx, async () => createAccount(ctx, await loadHub(ctx), spec));
    refreshTray();
    return made.map((p) => ({ id: p.id, label: p.label, tool: p.tool }));
  },

  /** Build (or rebuild) one profile's launcher app and show it in the Finder, ready to drag to the Dock. */
  async makeLauncher(id: string) {
    const hub = await loadHub(ctx);
    const app = await buildLauncher(ctx, hub, getProfile(hub, id));
    shell.showItemInFolder(app);
    return contractHome(app, ctx.home);
  },

  async removalInfo(id: string) {
    return removalInfo(ctx, await loadHub(ctx), id);
  },

  async removeProfile(id: string, opts: { unshare?: boolean; trash?: boolean }) {
    const hub = await loadHub(ctx);
    const r = await deleteProfile(ctx, hub, id, {
      unshare: !!opts.unshare,
      // The Finder's Trash, so Put Back works.
      ...(opts.trash ? { trash: (dir: string) => shell.trashItem(dir) } : {}),
    });
    refreshTray();
    return r;
  },

  async launch(id: string) {
    const hub = await loadHub(ctx);
    await launchProfile(ctx, hub, getProfile(hub, id));
  },

  async reveal(id: string) {
    const p = getProfile(await loadHub(ctx), id);
    const err = await shell.openPath(adapterFor(p).paths(ctx, p).root);
    if (err) throw new Error(err);
  },

  async discover() {
    return (await discover(ctx, await loadHub(ctx))).map((c) => ({
      profile: c.profile,
      source: c.source,
      identity: c.identity,
      warnings: c.warnings,
      state: c.state,
      registeredAs: c.registeredAs,
      folder: contractHome(adapterFor(c.profile).paths(ctx, c.profile).root, ctx.home),
    }));
  },

  async importProfiles(ids: string[]) {
    const hub = await loadHub(ctx);
    const { added } = await applyImport(ctx, hub, await discover(ctx, hub), { only: ids });
    refreshTray();
    return added.map((p) => p.id);
  },

  async buildLaunchers(ids?: string[]) {
    const hub = await loadHub(ctx);
    const out: { id: string; app?: string; error?: string }[] = [];
    for (const p of ids?.length ? ids.map((id) => getProfile(hub, id)) : hub.profiles) {
      try {
        out.push({ id: p.id, app: contractHome(await buildLauncher(ctx, hub, p), ctx.home) });
      } catch (err) {
        out.push({ id: p.id, error: (err as Error).message });
      }
    }
    return out;
  },

  async takeover(opts: { dryRun?: boolean }) {
    return takeover(ctx, await loadHub(ctx), opts);
  },

  async appInfo() {
    const cli = await fs.readFile(CLI_SHIM, 'utf8').catch(() => '');
    return { version: app.getVersion(), packaged: app.isPackaged, repo: UPDATE_REPO, cliInstalled: cli.includes(CLI_MARKER) };
  },

  async updateStatus() {
    return updateStatus;
  },

  async checkForUpdates() {
    return checkUpdates();
  },

  async installUpdate() {
    if (!app.isPackaged) throw new Error('Updates only apply to the packaged app.');
    if (updateStatus.state === 'downloading' || updateStatus.state === 'installing') return; // a second click
    if (updateStatus.state !== 'available' || !latestRelease) throw new Error('No update is ready to install.');
    const { current, latest } = updateStatus;
    // Claim the install before the first await, so a second click (window or tray) can't start another.
    setUpdateStatus({ state: 'downloading', current, latest, received: 0, total: 0 });
    let lastProgress = 0;
    const bundleId = await readPlistString(ctx, path.resolve(process.execPath, '../../Info.plist'), 'CFBundleIdentifier');
    try {
      if (!bundleId) throw new Error("Can't read this app's bundle id.");
      await downloadAndInstall({
        ctx,
        release: latestRelease,
        current,
        execPath: process.execPath,
        bundleId,
        relaunch: process.env.AIHUB_UPDATE_NO_RELAUNCH !== '1',
        onProgress: (received, total) => {
          // A download has thousands of chunks; a few updates a second is plenty for the progress bar.
          if (Date.now() - lastProgress < 250 && received < total) return;
          lastProgress = Date.now();
          setUpdateStatus({ state: 'downloading', current, latest, received, total });
        },
        quit: () => {
          setUpdateStatus({ state: 'installing', current, latest });
          setTimeout(() => app.quit(), 300);
        },
      });
    } catch (err) {
      setUpdateStatus({ state: 'error', current, message: (err as Error).message });
      throw err;
    }
  },

  async openReleasePage() {
    const url = updateStatus.state === 'available' ? updateStatus.url : `https://github.com/${UPDATE_REPO}/releases`;
    if (!url.startsWith('https://github.com/')) throw new Error('Refusing to open a non-GitHub URL.');
    await shell.openExternal(url);
  },

  async installCli() {
    return installCli();
  },
};

export type AihubApi = { [K in keyof typeof api]: (typeof api)[K] };

// The preload exposes exactly API_METHODS; make sure the two lists agree.
const exposed: readonly (keyof typeof api)[] = API_METHODS;
for (const name of exposed) {
  ipcMain.handle(`aihub:${name}`, (event, ...args: unknown[]) => {
    // Only our own page may call in (defense in depth: the window never navigates elsewhere).
    const url = event.senderFrame?.url ?? '';
    if (!url.startsWith('file://') && !(process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))) {
      throw new Error('Refused: request from an unexpected page.');
    }
    return (api[name] as (...a: unknown[]) => unknown)(...args);
  });
}

let tray: Tray | undefined;
let win: BrowserWindow | undefined;

const notifyUser = (title: string, body: string) => {
  if (Notification.isSupported()) new Notification({ title, body }).show();
};

/** Puts a Claude Desktop profile back when an update restarts it as the default account (see relaunch-watch). */
function watchClaudeUpdates() {
  const watcher = new UpdateRelaunchWatcher({
    now: Date.now,
    processes: () => listProcesses(ctx),
    appVersion: (a) => appVersion(ctx, a),
    reopen: async (p) => launchProfile(ctx, await loadHub(ctx), p),
    terminate: (pid) => {
      try {
        process.kill(pid, 'SIGTERM'); // Claude quits normally on SIGTERM
      } catch {
        // already gone
      }
    },
    report: (e) => {
      if (e.type === 'reopened') {
        notifyUser('Claude updated', `Reopened ${e.profile.label}${e.closedDefault ? ' and closed the default window the update opened' : ''}.`);
      } else if (e.type === 'reopen-failed') {
        notifyUser(`Could not reopen ${e.profile.label}`, e.message);
      }
    },
  });
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    void loadHub(ctx)
      .then((hub) => watchTargets(ctx, hub))
      .then((targets) => watcher.tick(targets))
      .catch(() => undefined) // a hub.yaml mid-edit or a failed ps: try again next tick
      .finally(() => (busy = false));
  }, 3000);
}

const openAtLogin = () => app.getLoginItemSettings().openAtLogin;
const loginItem = (): Electron.MenuItemConstructorOptions => ({
  label: 'Open at Login',
  type: 'checkbox',
  checked: openAtLogin(),
  enabled: app.isPackaged,
  click: (item) => {
    app.setLoginItemSettings({ openAtLogin: item.checked });
    void refreshTray();
    setAppMenu();
  },
});

async function refreshTray() {
  if (!tray) return;
  const hub = await loadHub(ctx).catch(() => ({ profiles: [] as Profile[] }));
  const items: Electron.MenuItemConstructorOptions[] = hub.profiles.map((p) => ({
    label: p.label,
    click: () => void api.launch(p.id).catch((err: Error) => dialog.showErrorBox(`Could not launch ${p.label}`, err.message)),
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Launch', enabled: false },
      ...(items.length ? items : [{ label: 'No profiles yet', enabled: false }]),
      { type: 'separator' },
      updateStatus.state === 'available'
        ? { label: `Install AI-Hub ${updateStatus.latest}…`, click: () => void api.installUpdate().catch((err: Error) => dialog.showErrorBox('Update failed', err.message)) }
        : { label: 'Check for Updates', enabled: app.isPackaged, click: () => void checkUpdates() },
      { label: 'Open AI-Hub', click: () => (win ? win.show() : createWindow()) },
      loginItem(),
      { label: 'Quit', role: 'quit' },
    ]),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: !SMOKE,
    title: 'AI-Hub',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: !!SMOKE,
    },
  });
  // The window only ever shows our own page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(here, '../renderer/index.html'));
  win.on('closed', () => (win = undefined));
  return win;
}

async function smoke(w: BrowserWindow, dir: string) {
  await fs.mkdir(dir, { recursive: true });
  const log: string[] = [];
  w.webContents.on('console-message', (e) => log.push(`[${e.level}] ${e.message}`));
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Optional scripted interaction through the real bridge (window.aihub), e.g. a share toggle.
  if (process.env.AIHUB_SMOKE_JS) {
    const result = await w.webContents.executeJavaScript(process.env.AIHUB_SMOKE_JS).catch((err: Error) => `error: ${err.message}`);
    await fs.writeFile(path.join(dir, 'script-result.json'), JSON.stringify(result, null, 2));
  }
  for (const page of ['profiles', 'sharing', 'library', 'health']) {
    await w.webContents.executeJavaScript(`window.__aihubNavigate && window.__aihubNavigate(${JSON.stringify(page)})`);
    await wait(page === 'profiles' ? 4000 : 2500);
    await fs.writeFile(path.join(dir, `${page}.png`), (await w.webContents.capturePage()).toPNG());
  }
  await fs.writeFile(path.join(dir, 'console.log'), log.join('\n') + '\n');
  app.quit();
}

function setAppMenu() {
  const menuCheck = async () => {
    const s = await checkUpdates();
    if (s.state === 'up-to-date') void dialog.showMessageBox({ message: `AI-Hub ${s.current} is the latest version.` });
    if (s.state === 'error') dialog.showErrorBox('Could not check for updates', s.message);
    if (s.state === 'available') win?.show();
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'AI-Hub',
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', enabled: app.isPackaged, click: () => void menuCheck() },
          {
            label: 'Install Command Line Tool…',
            enabled: app.isPackaged,
            click: () =>
              void installCli().then(
                (where) => dialog.showMessageBox({ message: `Installed ${where}`, detail: 'Make sure ~/.local/bin is on your PATH.' }),
                (err: Error) => dialog.showErrorBox('Could not install the command', err.message),
              ),
          },
          loginItem(),
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

// One copy at a time: a second launch just brings the first window forward.
if (!SMOKE && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => (win ? (win.show(), win.focus()) : createWindow()));

app.whenReady().then(() => {
  setAppMenu();
  if (SMOKE) {
    void smoke(createWindow(), SMOKE);
    return;
  }
  // Opened at login: just the menu bar item; the window opens from there.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
  watchClaudeUpdates();
  if (app.isPackaged) {
    setTimeout(() => void checkUpdates(), 5000);
    setInterval(() => void checkUpdates(), UPDATE_EVERY_MS);
  }
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('◎ AI');
  tray.setToolTip('AI-Hub');
  void refreshTray();
  app.on('activate', () => (win ? win.show() : createWindow()));
});

app.on('window-all-closed', () => {
  // Stay in the menu bar on macOS; the tray can reopen the window.
  if (process.platform !== 'darwin' || SMOKE) app.quit();
});
