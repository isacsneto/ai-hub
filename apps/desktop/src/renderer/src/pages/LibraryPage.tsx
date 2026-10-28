import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type Matrix } from '../api';
import type { Notify } from '../App';
import { Button, Chip, Empty, PageHeader, ProfileIcon } from '../components/ui';

type Row = Matrix['rows'][number];
const FILE_KINDS = ['skills', 'agents', 'commands', 'instructions'] as const;

export function LibraryPage({ notify }: { notify: Notify }) {
  const [matrix, setMatrix] = useState<Matrix>();
  const [selected, setSelected] = useState<Row>();
  const [text, setText] = useState<string>();

  const load = useCallback(() => {
    api.matrix().then(setMatrix).catch((e) => notify(errorText(e), 'bad'));
  }, [notify]);
  useEffect(load, [load]);

  // Keep a selection so the detail panel is never empty: the first item, or the same item after a reload.
  useEffect(() => {
    if (!matrix?.rows.length) return setSelected(undefined);
    setSelected((cur) => matrix.rows.find((r) => r.kind === cur?.kind && r.name === cur?.name) ?? matrix.rows[0]);
  }, [matrix]);

  useEffect(() => {
    setText(undefined);
    if (selected && (FILE_KINDS as readonly string[]).includes(selected.kind)) {
      api.itemText(selected.kind as (typeof FILE_KINDS)[number], selected.name).then(setText).catch((e) => setText(errorText(e)));
    }
  }, [selected]);

  const add = async (kind: (typeof FILE_KINDS)[number]) => {
    try {
      const item = await api.addLibraryItem(kind);
      if (item) {
        notify(`Added ${item.name}. Share it on the Sharing page.`, 'ok');
        load();
      }
    } catch (e) {
      notify(errorText(e), 'bad');
    }
  };

  const sharedWith = (row: Row) =>
    matrix ? matrix.profiles.filter((p) => matrix.cells[p.id]?.[`${row.kind}/${row.name}`]?.shared) : [];

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="Things stored once and shared into the profiles you pick. Every change is kept in the library's history."
        actions={
          <>
            <Button onClick={() => add('skills')}>Add skill folder…</Button>
            <Button onClick={() => add('instructions')}>Add instructions…</Button>
            <Button onClick={() => add('agents')}>Add agent…</Button>
            <Button onClick={() => add('commands')}>Add command…</Button>
          </>
        }
      />
      {matrix && !matrix.rows.length && (
        <Empty title="Nothing in the library yet">
          Add a skill folder, or move one from a profile with `aihub library promote &lt;profile&gt; skill &lt;name&gt;`.
        </Empty>
      )}
      {!!matrix?.rows.length && (
        <div className="grid grid-cols-[minmax(260px,340px)_1fr] gap-4">
          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {matrix.rows.map((row) => {
              const active = selected?.kind === row.kind && selected.name === row.name;
              return (
                <button
                  key={`${row.kind}/${row.name}`}
                  onClick={() => setSelected(row)}
                  className={`block w-full border-b border-line/70 px-3 py-2 text-left last:border-b-0 ${active ? 'bg-accent/10' : 'hover:bg-line/40'}`}
                >
                  <div className="flex items-center gap-2">
                    <Chip>{row.kind.replace(/s$/, '')}</Chip>
                    <span className="truncate font-medium">{row.name}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{row.description}</span>
                    <span className="flex shrink-0 gap-0.5" title={sharedWith(row).map((p) => p.label).join(', ') || 'Not shared yet'}>
                      {sharedWith(row).length ? (
                        sharedWith(row).map((p) => <ProfileIcon key={p.id} id={p.id} size={16} />)
                      ) : (
                        <span className="text-[11px] text-muted">not shared</span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-panel p-4">
            {selected && (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">{selected.name}</span>
                  <span className="text-muted">shared with</span>
                  {sharedWith(selected).length ? sharedWith(selected).map((p) => <Chip key={p.id} tone="info">{p.label}</Chip>) : <Chip>nobody yet</Chip>}
                </div>
                {text !== undefined ? (
                  <pre className="max-h-[60vh] overflow-auto rounded-lg bg-bg p-3 font-mono text-[12px] whitespace-pre-wrap">{text}</pre>
                ) : (
                  <div className="text-muted">{selected.description}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
