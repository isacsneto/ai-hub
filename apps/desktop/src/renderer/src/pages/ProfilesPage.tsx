import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type Candidate, type ProfileView, type RemovalInfo } from '../api';
import type { Notify } from '../App';
import { Button, Chip, Dialog, Empty, PageHeader, ProfileIcon, labelInitial, plural } from '../components/ui';

const COLORS = ['#3B7DD8', '#5DCAA5', '#E0A55E', '#7C5CC4', '#D25F8C', '#4CA9B2', '#6B7280'];

const BROWSER_LABELS: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', chromium: 'Chromium', vivaldi: 'Vivaldi' };

/** Say where it opens: terminal tools in Terminal, the rest as their own app or browser window. */
function openLabel(v: ProfileView): string {
  const p = v.profile;
  if (p.tool === 'claude-code' || p.tool === 'codex') return 'Open in Terminal';
  if (p.tool === 'browser') return `Open in ${BROWSER_LABELS[p.browser] ?? 'browser'}`;
  return 'Open app';
}

function AccountLine({ v }: { v: ProfileView }) {
  const id = v.identity;
  if (id.status === 'signed-in') return <span className="text-ok">{id.email ?? id.detail ?? 'Signed in'}</span>;
  if (id.status === 'signed-out') return <span className="text-warn">Not signed in{id.email ? ` (last: ${id.email})` : ''}</span>;
  // Desktop apps keep their login in encrypted app storage, browser profiles on the website: the hub can't read who it is.
  const text = v.profile.tool === 'claude-desktop' || !id.detail ? 'Login lives in the app' : id.detail.charAt(0).toUpperCase() + id.detail.slice(1);
  return <span className="text-muted">{text}</span>;
}

export function ProfilesPage({ notify }: { notify: Notify }) {
  const [views, setViews] = useState<ProfileView[]>();
  const [editing, setEditing] = useState<ProfileView>();
  const [removing, setRemoving] = useState<ProfileView>();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [iconVersion, setIconVersion] = useState(0);

  const load = useCallback(() => {
    api.profiles().then(setViews).catch((e) => notify(errorText(e), 'bad'));
  }, [notify]);
  useEffect(load, [load]);

  const launch = async (v: ProfileView) => {
    try {
      await api.launch(v.profile.id);
      notify(`Opening ${v.profile.label}…`, 'ok');
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  const toggleDock = async (v: ProfileView) => {
    try {
      if (v.inDock) {
        await api.removeFromDock(v.profile.id);
        notify(`Removed ${v.profile.label} from the Dock.`, 'ok');
      } else {
        await api.addToDock(v.profile.id);
        notify(`Added ${v.profile.label} to the Dock. Spotlight finds it too.`, 'ok');
      }
      load();
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  // One card per account: an app that runs on a CLI profile's folder joins that profile's card.
  const accounts = (views ?? [])
    .filter((v) => v.account === v.profile.id || !views?.some((o) => o.profile.id === v.account))
    .map((primary) => ({ primary, members: [primary, ...(views ?? []).filter((v) => v !== primary && v.account === primary.profile.id)] }));

  return (
    <>
      <PageHeader
        title="Profiles"
        subtitle="One card per account. A desktop app that runs on a terminal profile's folder (Claude Desktop's Code tab, the ChatGPT/Codex app) is listed with it."
        actions={
          <>
            <Button onClick={() => setImporting(true)}>Import existing…</Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              New profile…
            </Button>
          </>
        }
      />
      {views && !views.length && (
        <Empty title="No profiles yet">Import the accounts already on this Mac, or create a new one.</Empty>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
        {accounts.map(({ primary, members }) => (
          <div key={primary.profile.id} className="flex flex-col rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-3">
              <ProfileIcon id={primary.profile.id} size={40} version={iconVersion} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">{primary.profile.label}</div>
                <div className="truncate text-[12px] text-muted">{[...new Set(members.map((m) => m.toolName))].join(' · ')}</div>
              </div>
            </div>
            {members.map((v) => (
              <div key={v.profile.id} className="mt-3 border-t border-line pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium">{v.toolName}</span>
                  {members.length > 1 && v.profile.label !== primary.profile.label && <span className="text-[12px] text-muted">{v.profile.label}</span>}
                  {v.profile.managedBy && <Chip tone="info" title="The hub only reads this folder until you run `aihub takeover`">managed by {v.profile.managedBy}</Chip>}
                  {v.profile.tool === 'claude-desktop' && v.account === v.profile.id && (
                    <Chip tone={v.profile.codeProfile ? 'neutral' : 'warn'}>Code tab → {v.profile.codeProfile ?? '~/.claude'}</Chip>
                  )}
                  {v.tested.mcp === 'no' && (
                    <Chip tone="warn" title="This profile reads MCP servers from ~/.cursor, which every Cursor profile without its own home shares">
                      shared MCP
                    </Chip>
                  )}
                  {v.profile.tool === 'cursor' && v.profile.homeMode === 'isolated' && (
                    <Chip title="Cursor runs with its own HOME, so ~/.cursor (MCP servers, skills) is separate. Experimental.">own home</Chip>
                  )}
                </div>
                <div className="mt-1 space-y-0.5 text-[12px]">
                  <div>
                    <AccountLine v={v} />
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted" title={v.folder}>
                    {v.folder}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => launch(v)}>
                    {openLabel(v)}
                  </Button>
                  <Button onClick={() => setEditing(v)}>Edit</Button>
                  <Button
                    variant="ghost"
                    onClick={() => toggleDock(v)}
                    title={v.inDock ? 'Its icon stays in ~/Applications/AI-Hub, so Spotlight still finds it' : 'Adds an icon that opens this profile, with its badge, to the Dock'}
                  >
                    {v.inDock ? 'Remove from Dock' : 'Add to Dock'}
                  </Button>
                  <Button variant="ghost" onClick={() => api.reveal(v.profile.id).catch((e) => notify(errorText(e), 'bad'))}>
                    Show folder
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {editing && (
        <EditDialog
          view={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(launcher) => {
            setEditing(undefined);
            setIconVersion((n) => n + 1);
            load();
            notify(launcher ? `Saved, and updated its launcher ${launcher}.` : 'Saved.', 'ok');
          }}
          onRemove={() => {
            setRemoving(editing);
            setEditing(undefined);
          }}
          notify={notify}
        />
      )}
      {removing && (
        <RemoveDialog
          view={removing}
          onClose={() => setRemoving(undefined)}
          onDone={() => {
            setRemoving(undefined);
            load();
          }}
          notify={notify}
        />
      )}
      {adding && (
        <NewAccountDialog
          onClose={() => setAdding(false)}
          onDone={(made) => {
            setAdding(false);
            load();
            notify(`Created ${made.map((m) => m.label).join(' and ')}. Launch it to sign in.`, 'ok');
          }}
          notify={notify}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={(n) => {
            setImporting(false);
            load();
            if (n) notify(`Imported ${plural(n, 'profile')}. Nothing inside their folders changed.`, 'ok');
          }}
          notify={notify}
        />
      )}
    </>
  );
}

function EditDialog({
  view,
  onClose,
  onSaved,
  onRemove,
  notify,
}: {
  view: ProfileView;
  onClose: () => void;
  onSaved: (launcher?: string) => void;
  onRemove: () => void;
  notify: Notify;
}) {
  const [label, setLabel] = useState(view.profile.label);
  const [badge, setBadge] = useState(view.profile.icon?.badge ?? '');
  const [color, setColor] = useState(view.profile.icon?.color ?? COLORS[0]!);
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    const t = setTimeout(() => {
      api.iconPreview(view.profile.id, { ...(badge ? { badge } : {}), color }, 256).then(setPreview).catch(() => undefined);
    }, 150);
    return () => clearTimeout(t);
  }, [view.profile.id, badge, color]);

  const save = async () => {
    try {
      onSaved(await api.updateProfile(view.profile.id, { label, icon: { ...(badge ? { badge } : {}), color } }));
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  return (
    <Dialog title={`Edit ${view.profile.label}`} onClose={onClose}>
      <div className="flex gap-5">
        <div className="flex w-32 shrink-0 flex-col items-center gap-2">
          {preview ? <img src={preview} width={112} height={112} alt="Icon preview" /> : <div className="h-28 w-28 rounded-3xl bg-line" />}
          <span className="text-[11px] text-muted">Dock icon preview</span>
        </div>
        <div className="flex-1 space-y-3">
          <label className="block">
            <span className="text-[12px] text-muted">Name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent" />
          </label>
          <label className="block">
            <span className="text-[12px] text-muted">Badge (1–2 characters)</span>
            <input
              value={badge}
              maxLength={2}
              placeholder={labelInitial(label)}
              onChange={(e) => setBadge(e.target.value.toUpperCase())}
              className="mt-1 w-20 rounded-md border border-line bg-bg px-2 py-1.5 text-center font-semibold outline-none focus:border-accent"
            />
          </label>
          <div>
            <span className="text-[12px] text-muted">Color</span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={c}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-text' : 'border-transparent'}`}
                  style={{ background: c }}
                />
              ))}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="h-6 w-8 cursor-pointer bg-transparent" />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="danger" className="mr-auto" onClick={onRemove}>
          Remove…
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}

function RemoveDialog({ view, onClose, onDone, notify }: { view: ProfileView; onClose: () => void; onDone: () => void; notify: Notify }) {
  const { id, label, tool } = view.profile;
  const [info, setInfo] = useState<RemovalInfo>();
  const [loadError, setLoadError] = useState<string>();
  const [unshare, setUnshare] = useState(true);
  const [trash, setTrash] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.removalInfo(id).then(setInfo).catch((e) => setLoadError(errorText(e)));
  }, [id]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.removeProfile(id, { unshare: unshare && !info?.readOnly, trash });
      const parts = [`Removed ${label}.`];
      if (r.trashed) parts.push('Its folder is in the Trash.');
      if (r.unshared) parts.push(`Took out ${plural(r.unshared, 'shared item')}.`);
      if (r.leftInPlace) parts.push(`${plural(r.leftInPlace, 'shared item')} stayed in its folder.`);
      notify(parts.join(' '), 'ok');
      onDone();
    } catch (e) {
      notify(errorText(e), 'bad');
      setBusy(false);
    }
  };

  const blocked = !!info?.usedBy.length;
  return (
    <Dialog title={`Remove ${label}?`} onClose={onClose}>
      {loadError ? (
        <p className="text-bad">{loadError}</p>
      ) : !info ? (
        <p className="text-muted">Checking…</p>
      ) : blocked ? (
        <p>
          {info.usedBy.join(', ')} {info.usedBy.length === 1 ? 'uses' : 'use'} this profile for its Code tab. Remove{' '}
          {info.usedBy.length === 1 ? 'that profile' : 'those profiles'} first.
        </p>
      ) : (
        <div className="space-y-3">
          <p>
            AI-Hub stops managing this profile.{' '}
            {trash ? (
              'Its folder goes to the Trash.'
            ) : (
              <>
                Its folder and login stay where they are: <code className="text-[12px]">{info.folder}</code>
              </>
            )}
          </p>
          {info.shared > 0 && !trash &&
            (info.readOnly ? (
              <p className="text-muted">{plural(info.shared, 'shared item')} stay in the folder, since another tool manages it.</p>
            ) : (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={unshare} onChange={(e) => setUnshare(e.target.checked)} />
                <span>
                  Also take out the {plural(info.shared, 'item')} AI-Hub shared into it
                  <span className="block text-[12px] text-muted">Undo on the Sharing page puts the files back. Plugins stay installed.</span>
                </span>
              </label>
            ))}
          {info.canTrash && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
              <span>
                Move its folder to the Trash
                <span className="block text-[12px] text-muted">
                  Deletes this profile's login, settings and history. Quit it first, including terminal sessions.
                  {tool === 'claude-code' ? ' The Claude Code login saved in the Keychain stays; run /logout in it first to remove that too.' : ''}
                </span>
              </span>
            </label>
          )}
          {!info.canTrash && info.sharesFolderWith.length > 0 && (
            <p className="text-[12px] text-muted">Its folder stays: {info.sharesFolderWith.join(', ')} uses it too.</p>
          )}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={run} disabled={!info || blocked || busy}>
          {trash ? 'Remove and trash folder' : 'Remove'}
        </Button>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose, onDone, notify }: { onClose: () => void; onDone: (n: number) => void; notify: Notify }) {
  const [found, setFound] = useState<Candidate[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .discover()
      .then((c) => {
        setFound(c);
        setPicked(new Set(c.filter((x) => x.state === 'new' && x.identity?.status !== 'signed-out').map((x) => x.profile.id)));
      })
      .catch((e) => notify(errorText(e), 'bad'));
  }, [notify]);

  const run = async () => {
    try {
      onDone((await api.importProfiles([...picked])).length);
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  return (
    <Dialog title="Import existing accounts" onClose={onClose}>
      <p className="mb-3 text-muted">Found on this Mac. Importing only registers them; nothing inside their folders changes.</p>
      {!found && <div className="text-muted">Looking…</div>}
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {found?.map((c) => (
          <label key={c.profile.id} className={`flex items-start gap-2 rounded-md p-2 ${c.state === 'new' ? 'hover:bg-line/40' : 'opacity-60'}`}>
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={c.state !== 'new'}
              checked={picked.has(c.profile.id)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(c.profile.id);
                else next.delete(c.profile.id);
                setPicked(next);
              }}
            />
            <div className="min-w-0">
              <div className="font-medium">
                {c.profile.label} <span className="font-normal text-muted">· {c.profile.id}</span>
              </div>
              <div className="truncate font-mono text-[11px] text-muted">{c.folder}</div>
              <div className="text-[11.5px] text-muted">
                {c.state === 'registered' ? `Already registered as ${c.registeredAs}` : [c.identity?.email, ...c.warnings].filter(Boolean).join(' · ') || c.source}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={run} disabled={!picked.size}>
          Import {picked.size || ''}
        </Button>
      </div>
    </Dialog>
  );
}

type Kind = 'claude' | 'codex' | 'cursor' | 'web';
const KINDS: { kind: Kind; title: string; detail: string }[] = [
  { kind: 'claude', title: 'Claude', detail: 'Claude Code in the terminal, and optionally the Claude desktop app' },
  { kind: 'codex', title: 'Codex / ChatGPT', detail: 'Codex in the terminal, and optionally the ChatGPT/Codex app' },
  { kind: 'cursor', title: 'Cursor', detail: 'A separate Cursor window with its own login and settings' },
  { kind: 'web', title: 'Web account', detail: 'A site like claude.ai or chatgpt.com in its own browser profile' },
];
const SITES = [
  { name: 'Claude', url: 'https://claude.ai' },
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Gemini', url: 'https://gemini.google.com' },
];

function NewAccountDialog({ onClose, onDone, notify }: { onClose: () => void; onDone: (made: { id: string; label: string }[]) => void; notify: Notify }) {
  const [kind, setKind] = useState<Kind>('claude');
  const [name, setName] = useState('');
  const [app, setApp] = useState(true);
  const [isolatedHome, setIsolatedHome] = useState(false);
  const [url, setUrl] = useState(SITES[0]!.url);
  const [browsers, setBrowsers] = useState<string[]>();
  const [browser, setBrowser] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.installedBrowsers().then((b) => {
      setBrowsers(b);
      setBrowser(b[0]);
    }).catch(() => setBrowsers([]));
  }, []);

  const spec = () => {
    if (kind === 'claude' || kind === 'codex') return { kind, name, app };
    if (kind === 'cursor') return { kind, name, isolatedHome };
    return { kind, name, url, browser: browser as 'chrome' };
  };
  const run = async () => {
    setBusy(true);
    try {
      onDone(await api.newAccount(spec()));
    } catch (e) {
      notify(errorText(e), 'bad');
      setBusy(false);
    }
  };
  const field = 'mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 outline-none focus:border-accent';
  const appName = kind === 'claude' ? 'the Claude desktop app' : 'the ChatGPT/Codex app';

  return (
    <Dialog title="New profile" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && name.trim() && !(kind === 'web' && !browser)) void run();
        }}
      >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={`rounded-lg border p-2.5 text-left ${kind === k.kind ? 'border-accent bg-accent/10' : 'border-line hover:border-muted'}`}
            >
              <div className="text-[13px] font-semibold">{k.title}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{k.detail}</div>
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-[12px] text-muted">Account name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Acme, Personal…" className={field} />
        </label>
        {(kind === 'claude' || kind === 'codex') && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={app} onChange={(e) => setApp(e.target.checked)} />
            <span>
              Also open it in {appName}
              <span className="block text-[12px] text-muted">
                {kind === 'claude'
                  ? "The app's Code tab uses this profile's folder. Sign in once in each: the app keeps its own login."
                  : 'Both use the same folder, so one sign-in covers both.'}
              </span>
            </span>
          </label>
        )}
        {kind === 'cursor' && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={isolatedHome} onChange={(e) => setIsolatedHome(e.target.checked)} />
            <span>
              Keep its MCP servers separate too
              <span className="block text-[12px] text-muted">Gives Cursor its own home folder, since ~/.cursor is otherwise shared. Experimental.</span>
            </span>
          </label>
        )}
        {kind === 'web' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[12px] text-muted">Site</span>
              <input list="aihub-sites" value={url} onChange={(e) => setUrl(e.target.value)} className={field} />
              <datalist id="aihub-sites">
                {SITES.map((s) => (
                  <option key={s.url} value={s.url}>
                    {s.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="text-[12px] text-muted">Browser</span>
              <select value={browser} onChange={(e) => setBrowser(e.target.value)} className={field} disabled={!browsers?.length}>
                {browsers?.map((b) => (
                  <option key={b} value={b}>
                    {BROWSER_LABELS[b] ?? b}
                  </option>
                ))}
              </select>
              {browsers && !browsers.length && <span className="mt-1 block text-[12px] text-warn">No Chromium browser found (Chrome, Edge, Brave…).</span>}
            </label>
          </div>
        )}
        <p className="text-[12px] text-muted">Its folders go in ~/.aihub/profiles. You sign in the first time you launch it.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || (kind === 'web' && !browser)}>
          Create
        </Button>
      </div>
      </form>
    </Dialog>
  );
}
