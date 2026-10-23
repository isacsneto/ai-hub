import { useEffect, useState } from 'react';
import { api, errorText, type DoctorReport } from '../api';
import { Button, Chip, PageHeader } from '../components/ui';

type Finding = DoctorReport['findings'][number];

const LEVEL: Record<Finding['level'], { mark: string; cls: string }> = {
  ok: { mark: '✓', cls: 'text-ok' },
  info: { mark: '·', cls: 'text-info' },
  warn: { mark: '⚠', cls: 'text-warn' },
  error: { mark: '✗', cls: 'text-bad' },
};

export function HealthPage() {
  const [report, setReport] = useState<DoctorReport>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  const run = () => {
    setRunning(true);
    api
      .doctor()
      .then((r) => (setReport(r), setError(undefined)))
      .catch((e) => setError(errorText(e)))
      .finally(() => setRunning(false));
  };
  useEffect(run, []);

  const groups = new Map<string, Finding[]>();
  for (const f of report?.findings ?? []) {
    const key = f.profile ?? (f.tool ? `Tool: ${f.tool}` : 'Hub');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  return (
    <>
      <PageHeader
        title="Health"
        subtitle="Checks that each account stays separate, against what has actually been tested for your tool versions."
        actions={
          <Button onClick={run} disabled={running}>
            {running ? 'Checking…' : 'Check again'}
          </Button>
        }
      />
      {error && <div className="mb-3 rounded-lg border border-bad/50 bg-bad/10 px-3 py-2">{error}</div>}
      {report && (
        <div className="mb-4 flex gap-2">
          <Chip tone={report.errors ? 'bad' : 'ok'}>{report.errors} error(s)</Chip>
          <Chip tone={report.warnings ? 'warn' : 'ok'}>{report.warnings} warning(s)</Chip>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-3">
        {[...groups].map(([key, findings]) => (
          <div key={key} className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 font-semibold">{key}</div>
            <ul className="space-y-1.5">
              {findings.map((f, i) => (
                <li key={i} className="flex gap-2 text-[12.5px]">
                  <span className={`w-3 shrink-0 text-center font-bold ${LEVEL[f.level].cls}`}>{LEVEL[f.level].mark}</span>
                  <div className="min-w-0">
                    <span>{f.message}</span> {f.kind === 'isolation' && <Chip tone="bad">isolation</Chip>}
                    {f.hint && <div className="mt-0.5 font-mono text-[11px] text-muted">{f.hint}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
