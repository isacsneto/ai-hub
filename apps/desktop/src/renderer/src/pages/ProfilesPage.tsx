import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type Candidate, type ProfileView } from '../api';
import type { Notify } from '../App';
import { Button, Chip, Dialog, Empty, PageHeader, ProfileIcon } from '../components/ui';

const COLORS = ['#3B7DD8', '#5DCAA5', '#E0A55E', '#7C5CC4', '#D25F8C', '#4CA9B2', '#6B7280'];

function AccountLine({ v }: { v: ProfileView }) {
  const id = v.identity;
  if (id.status === 'signed-in') return <span className="text-ok">{id.email ?? id.detail ?? 'Signed in'}</span>;
  if (id.status === 'signed-out') return <span className="text-warn">Not signed in{id.email ? ` (last: ${id.email})` : ''}</span>;
  // App and browser profiles keep their login inside the app; the hub can't read who it is.
  return <span className="text-muted">Login lives in the app</span>;
}

export function ProfilesPage({ notify }: { notify: Notify }) {
  const [views, setViews] = useState<ProfileView[]>();
  const [editing, setEditing] = useState<ProfileView>();
  const [importing, setImporting] = useState(false);
  const [iconVersion, setIconVersion] = useState(0);

  const load = useCallback(() => {
    api.profiles().then(setViews).catch((e) => notify(errorText(e), 'bad'));
  }, [notify]);
  useEffect(load, [load]);

  const launch = async (v: ProfileView) => {
    try {
      await api.launch(v.profile.id);
      notify(`Launching ${v.profile.label}…`, 'ok');
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  const buildLaunchers = async () => {
    const res = await api.buildLaunchers();
    const bad = res.filter((r) => r.error);
    notify(bad.length ? `${bad.length} launcher(s) failed: ${bad[0]!.error}` : `Built ${res.length} launcher(s) in ~/Applications/AI-Hub`, bad.length ? 'bad' : 'ok');
  };

  return (
    <>
      <PageHeader
        title="Profiles"
        subtitle="Each profile is one account in one tool, with its own login, MCP servers and history."
        actions={
          <>
            <Button onClick={() => setImporting(true)}>Import existing…</Button>
            <Button onClick={buildLaunchers} disabled={!views?.length}>Build Dock launchers</Button>
          </>
        }
      />
      {views && !views.length && (
        <Empty title="No profiles yet">Import the accounts already on this Mac, or add one with `aihub profile add`.</Empty>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
        {views?.map((v) => (
          <div key={v.profile.id} className="flex flex-col rounded-xl border border-line bg-panel p-4">
            <div className="flex items-start gap-3">
              <ProfileIcon id={v.profile.id} size={48} version={iconVersion} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold">{v.profile.label}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <Chip>{v.toolName}</Chip>
                  {v.profile.managedBy && <Chip tone="info" title="The hub only reads this folder until you run `aihub takeover`">managed by {v.profile.managedBy}</Chip>}
                  {v.profile.tool === 'claude-desktop' && (
                    <Chip tone={v.profile.codeProfile ? 'neutral' : 'warn'}>Code tab → {v.profile.codeProfile ?? '~/.claude'}</Chip>
                  )}
                  {v.tested.mcp === 'no' && <Chip tone="warn" title="This tool keeps MCP servers in a folder every profile shares">shared MCP</Chip>}
                </div>
              </div>
            </div>
            <div className="mt-3 space-y-0.5 text-[12px]">
              <div>
                <AccountLine v={v} />
              </div>
              <div className="truncate font-mono text-[11px] text-muted" title={v.folder}>
                {v.folder}
              </div>
            </div>
            <div className="mt-3 flex gap-2 pt-1">
              <Button variant="primary" onClick={() => launch(v)}>
                Launch
              </Button>
              <Button onClick={() => setEditing(v)}>Edit</Button>
              <Button variant="ghost" onClick={() => api.reveal(v.profile.id).catch((e) => notify(errorText(e), 'bad'))}>
                Show folder
              </Button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <EditDialog
          view={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setIconVersion((n) => n + 1);
            load();
            notify('Saved. Rebuild launchers to update Dock icons.', 'ok');
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
            if (n) notify(`Imported ${n} profile(s). Nothing inside their folders changed.`, 'ok');
          }}
          notify={notify}
        />
      )}
    </>
  );
}

function EditDialog({ view, onClose, onSaved, notify }: { view: ProfileView; onClose: () => void; onSaved: () => void; notify: Notify }) {
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
      await api.updateProfile(view.profile.id, { label, icon: { ...(badge ? { badge } : {}), color } });
      onSaved();
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
