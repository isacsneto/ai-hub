import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errorText, type Matrix, type Plan } from '../api';
import type { Notify } from '../App';
import { Button, Chip, Dialog, Empty, PageHeader, ProfileIcon, plural } from '../components/ui';

type Row = Matrix['rows'][number];
type Kind = Row['kind'];

const KIND_LABEL: Record<Kind, string> = {
  skills: 'Skills',
  agents: 'Agents',
  commands: 'Commands',
  instructions: 'Instructions',
  plugins: 'Plugins',
  settings: 'Settings',
};

const STATUS_DOT: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'bg-ok', label: 'In place' },
  done: { cls: 'bg-ok', label: 'In place' },
  pending: { cls: 'bg-warn', label: 'Not applied yet' },
  blocked: { cls: 'bg-warn ring-2 ring-warn/30', label: 'Waiting for approval' },
  conflict: { cls: 'bg-bad', label: 'Conflict' },
  failed: { cls: 'bg-bad', label: 'Failed' },
};

interface Pending {
  row: Row;
  profileId: string;
  on: boolean;
}

/** What a blocked plan needs from the user, if anything. */
function blockers(plan: Plan) {
  const blocked = plan.actions.filter((a) => a.status === 'blocked');
  return {
    detach: blocked.find((a) => a.reason?.includes('--detach')),
    managed: blocked.find((a) => a.reason?.includes('managed by')),
    mcp: blocked.find((a) => a.reason?.includes('--allow-mcp')),
  };
}

export function SharingPage({ notify }: { notify: Notify }) {
  const [matrix, setMatrix] = useState<Matrix>();
  const [busy, setBusy] = useState(false);
  const [confirmMcp, setConfirmMcp] = useState<Pending>();
  const [followUp, setFollowUp] = useState<{ req: Pending; plan: Plan }>();

  const load = useCallback(() => {
    api.matrix().then(setMatrix).catch((e) => notify(errorText(e), 'bad'));
  }, [notify]);
  useEffect(load, [load]);

  const send = async (req: Pending, extra: { allowMcp?: boolean; detach?: boolean; force?: boolean } = {}) => {
    setBusy(true);
    try {
      const plan = await api.setShare({ kind: req.row.kind, name: req.row.name, profileId: req.profileId, on: req.on, ...extra });
      const b = blockers(plan);
      if (b.detach || b.managed) setFollowUp({ req, plan });
      const failed = plan.actions.find((a) => a.status === 'failed' || a.status === 'conflict');
      if (failed) notify(`${failed.kind}/${failed.name}: ${failed.reason}`, 'bad');
      else if (!b.detach && !b.managed) notify(`${req.on ? 'Shared' : 'Removed'} ${req.row.name} ${req.on ? 'with' : 'from'} ${req.profileId}`, 'ok');
    } catch (e) {
      notify(errorText(e), 'bad');
    } finally {
      setBusy(false);
      load();
    }
  };

  const toggle = (row: Row, profileId: string, on: boolean) => {
    const req = { row, profileId, on };
    // Plugins that add (or may add) MCP servers need an explicit yes per profile.
    if (on && row.kind === 'plugins' && row.mcp && (row.mcp.servers.length || !row.mcp.known)) setConfirmMcp(req);
    else void send(req);
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      const plans = await api.applyAll();
      const done = plans.flatMap((p) => p.actions).filter((a) => a.status === 'done').length;
      const stuck = plans.flatMap((p) => p.actions).filter((a) => ['blocked', 'conflict', 'failed'].includes(a.status)).length;
      notify(`${plural(done, 'change')} applied${stuck ? `, ${stuck} need attention` : ''}.`, stuck ? 'info' : 'ok');
    } catch (e) {
      notify(errorText(e), 'bad');
    } finally {
      setBusy(false);
      load();
    }
  };

  const undo = async () => {
    const r = await api.undo().catch((e) => (notify(errorText(e), 'bad'), null));
    notify(r ? `Undid "${r.label}" (${plural(r.reverted, 'change')}).` : 'Nothing to undo.', r ? 'ok' : 'info');
    load();
  };

  if (!matrix) return <PageHeader title="Sharing" subtitle="Loading…" />;
  const kinds = [...new Set(matrix.rows.map((r) => r.kind))];
  // Profiles whose tool can't take any library item (browser, Cursor) only add columns of dashes.
  const columns = matrix.profiles.filter((p) => matrix.rows.some((r) => matrix.cells[p.id]?.[`${r.kind}/${r.name}`]?.supported));
  const hidden = matrix.profiles.filter((p) => !columns.includes(p));
  const pendingCount = Object.values(matrix.cells).flatMap((c) => Object.values(c)).filter((c) => c.status === 'pending').length;

  return (
    <>
      <PageHeader
        title="Sharing"
        subtitle="Tick what each profile should get from the library. Everything else stays private to the profile."
        actions={
          <>
            <Button onClick={undo} disabled={busy}>
              Undo last change
            </Button>
            <Button variant="primary" onClick={applyAll} disabled={busy || !pendingCount}>
              Apply {pendingCount ? `${pendingCount} pending` : 'all'}
            </Button>
          </>
        }
      />

      {matrix.everyone.map((e) => (
        <div key={e.path} className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px]">
          <span className="font-semibold">{e.path}</span> · {plural(e.entries.length, 'item')} · {e.note}
        </div>
      ))}

      {!matrix.rows.length ? (
        <Empty title="The library is empty">Add skills or instructions on the Library page, then share them here.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-line">
                <th className="sticky left-0 z-10 min-w-64 bg-panel px-3 py-2 text-left font-medium text-muted">Library item</th>
                {columns.map((p) => (
                  <th key={p.id} className="min-w-28 px-2 py-2 font-medium">
                    <div className="flex flex-col items-center gap-1" title={p.label}>
                      <ProfileIcon id={p.id} size={28} />
                      {/* "Claude Code · Work" → "Work" over a smaller "Claude Code" so narrow columns stay readable. */}
                      <span className="max-w-32 truncate leading-tight">{p.label.split(' · ').slice(1).join(' · ') || p.label}</span>
                      {p.label.includes(' · ') && (
                        <span className="max-w-32 truncate text-[10.5px] leading-tight font-normal text-muted">{p.label.split(' · ')[0]}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kinds.map((kind) => (
                <Fragment key={kind}>
                  <tr>
                    <td colSpan={columns.length + 1} className="bg-bg/60 px-3 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                      {KIND_LABEL[kind]}
                    </td>
                  </tr>
                  {matrix.rows
                    .filter((r) => r.kind === kind)
                    .map((row) => (
                      <tr key={`${row.kind}/${row.name}`} className="border-t border-line/70">
                        <td className="sticky left-0 bg-panel px-3 py-2">
                          <div className="flex items-center gap-1.5 font-medium">
                            {row.name}
                            {row.mcp && row.mcp.servers.length > 0 && <Chip tone="warn" title="MCP servers this plugin adds">MCP: {row.mcp.servers.join(', ')}</Chip>}
                            {row.mcp && !row.mcp.known && !row.mcp.servers.length && <Chip tone="warn">MCP unknown</Chip>}
                          </div>
                          {row.description && <div className="max-w-80 truncate text-[11.5px] text-muted">{row.description}</div>}
                        </td>
                        {columns.map((p) => {
                          const cell = matrix.cells[p.id]?.[`${row.kind}/${row.name}`];
                          if (!cell?.supported) {
                            return (
                              <td key={p.id} className="px-2 py-2 text-center text-muted" title={cell?.reason}>
                                –
                              </td>
                            );
                          }
                          const dot = cell.shared && cell.status ? STATUS_DOT[cell.status] : undefined;
                          return (
                            <td key={p.id} className="px-2 py-2 text-center" title={[dot?.label, cell.reason].filter(Boolean).join(': ')}>
                              <span className="inline-flex items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 accent-[var(--accent)]"
                                  checked={cell.shared}
                                  disabled={busy}
                                  onChange={(e) => toggle(row, p.id, e.target.checked)}
                                />
                                <span className={`h-2 w-2 rounded-full ${dot?.cls ?? 'bg-transparent'}`} />
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex gap-4 text-[11.5px] text-muted">
        {Object.entries({ ok: 'In place', pending: 'Not applied yet', blocked: 'Needs approval', conflict: 'Conflict' }).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[k]!.cls}`} />
            {label}
          </span>
        ))}
        <span>– not supported by that tool (hover for why)</span>
      </div>
      {!!matrix.rows.length && hidden.length > 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          Not shown: {hidden.map((p) => p.label).join(', ')}. {hidden.length === 1 ? 'Its tool keeps' : 'Their tools keep'} skills and instructions in the app or account,
          so there's nothing to share into {hidden.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {confirmMcp && (
        <Dialog title={`Allow MCP servers for ${confirmMcp.profileId}?`} onClose={() => setConfirmMcp(undefined)}>
          <p>
            <span className="font-semibold">{confirmMcp.row.name}</span>{' '}
            {confirmMcp.row.mcp?.servers.length
              ? `adds these MCP servers: ${confirmMcp.row.mcp.servers.join(', ')}.`
              : "comes from a remote source, so its MCP servers can't be checked before installing."}
          </p>
          <p className="mt-2 text-muted">They'll be installed into this profile only, with their own credentials.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmMcp(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void send(confirmMcp, { allowMcp: true });
                setConfirmMcp(undefined);
              }}
            >
              Allow and install
            </Button>
          </div>
        </Dialog>
      )}

      {followUp && (
        <Dialog title="This change needs one more step" onClose={() => setFollowUp(undefined)}>
          {(() => {
            const b = blockers(followUp.plan);
            const close = () => setFollowUp(undefined);
            if (b.detach) {
              return (
                <>
                  <p>{b.detach.reason}</p>
                  <p className="mt-2 text-muted">The link is moved into the hub's journal, so “Undo last change” puts it back.</p>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>
                      Not now
                    </Button>
                    <Button variant="primary" onClick={() => (close(), void send(followUp.req, { detach: true }))}>
                      Switch to per-item links
                    </Button>
                  </div>
                </>
              );
            }
            return (
              <>
                <p>{b.managed?.reason}</p>
                <p className="mt-2 text-muted">Writing anyway can be undone, but the other tool may change things back. Taking the folder over is cleaner.</p>
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>
                    Not now
                  </Button>
                  <Button variant="danger" onClick={() => (close(), void send(followUp.req, { force: true }))}>
                    Write anyway
                  </Button>
                </div>
              </>
            );
          })()}
        </Dialog>
      )}
    </>
  );
}
