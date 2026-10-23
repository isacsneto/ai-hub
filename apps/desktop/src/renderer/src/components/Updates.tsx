import { useEffect, useState } from 'react';
import { api, errorText, type UpdateStatus } from '../api';
import type { Notify } from '../App';
import { Button } from './ui';

type AppInfo = Awaited<ReturnType<typeof api.appInfo>>;

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [info, setInfo] = useState<AppInfo>();
  useEffect(() => {
    void api.updateStatus().then(setStatus);
    void api.appInfo().then(setInfo);
    return api.onUpdate(setStatus);
  }, []);
  return { status, info, refreshInfo: () => void api.appInfo().then(setInfo) };
}

/** Banner across the top while an update is available, downloading or installing. */
export function UpdateBanner({ status, notify }: { status?: UpdateStatus; notify: Notify }) {
  if (!status) return null;
  if (status.state === 'available') {
    return (
      <div className="mb-5 flex items-center gap-3 rounded-lg border border-info/40 bg-info/10 px-3 py-2">
        <div className="flex-1">
          <span className="font-semibold">AI-Hub {status.latest} is available</span>
          <span className="text-muted"> · you have {status.current}</span>
        </div>
        <Button variant="ghost" onClick={() => void api.openReleasePage()}>
          What's new
        </Button>
        <Button variant="primary" onClick={() => api.installUpdate().catch((e) => notify(errorText(e), 'bad'))}>
          Install and restart
        </Button>
      </div>
    );
  }
  if (status.state === 'downloading' || status.state === 'installing') {
    const pct = status.state === 'downloading' && status.total ? Math.round((status.received / status.total) * 100) : 100;
    return (
      <div className="mb-5 rounded-lg border border-line bg-panel px-3 py-2">
        <div className="mb-1.5 text-[12.5px]">
          {status.state === 'downloading' ? `Downloading AI-Hub ${status.latest}… ${pct}%` : `Installing ${status.latest}; AI-Hub will reopen.`}
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-line">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return null;
}

/** Version, update check and CLI install, for the bottom of the sidebar. */
export function VersionFooter({ status, info, notify, onCliInstalled }: { status?: UpdateStatus; info?: AppInfo; notify: Notify; onCliInstalled: () => void }) {
  if (!info) return null;
  const line =
    status?.state === 'checking'
      ? 'Checking…'
      : status?.state === 'up-to-date'
        ? 'Up to date'
        : status?.state === 'error'
          ? 'Update check failed'
          : status?.state === 'available'
            ? `${status.latest} available`
            : '';
  return (
    <div className="no-drag mt-3 space-y-1 px-2 text-[11px] text-muted">
      <div title={status?.state === 'error' ? status.message : undefined}>
        v{info.version}
        {line && ` · ${line}`}
      </div>
      {info.packaged ? (
        <div className="flex flex-wrap gap-x-2">
          <button className="underline-offset-2 hover:underline" onClick={() => void api.checkForUpdates()}>
            Check for updates
          </button>
          {!info.cliInstalled && (
            <button
              className="underline-offset-2 hover:underline"
              onClick={() =>
                api.installCli().then(
                  (where) => (notify(`Installed ${where}. Make sure ~/.local/bin is on your PATH.`, 'ok'), onCliInstalled()),
                  (e) => notify(errorText(e), 'bad'),
                )
              }
            >
              Install `aihub` command
            </button>
          )}
        </div>
      ) : (
        <div>Development build: updates are off</div>
      )}
    </div>
  );
}
