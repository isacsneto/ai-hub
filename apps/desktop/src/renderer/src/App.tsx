import { useCallback, useEffect, useState } from 'react';
import { UpdateBanner, VersionFooter, useUpdates } from './components/Updates';
import { Toasts, type ToastMsg } from './components/ui';
import { HealthPage } from './pages/HealthPage';
import { LibraryPage } from './pages/LibraryPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { SharingPage } from './pages/SharingPage';

export type Notify = (text: string, tone?: ToastMsg['tone']) => void;

const PAGES = [
  { id: 'profiles', label: 'Profiles', hint: 'Accounts and launchers' },
  { id: 'sharing', label: 'Sharing', hint: 'What each profile gets' },
  { id: 'library', label: 'Library', hint: 'Skills, agents, instructions' },
  { id: 'health', label: 'Health', hint: 'Isolation checks' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

export function App() {
  const [page, setPage] = useState<PageId>('profiles');
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const updates = useUpdates();

  const notify: Notify = useCallback((text, tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 8000 : 4000);
  }, []);

  // Lets the smoke test (and future deep links) switch pages.
  useEffect(() => {
    (window as unknown as { __aihubNavigate: (p: PageId) => void }).__aihubNavigate = setPage;
  }, []);

  return (
    <div className="flex h-full">
      <aside className="drag flex w-52 shrink-0 flex-col border-r border-line bg-sidebar px-3 pt-12 pb-4">
        <div className="mb-6 px-2">
          <div className="text-[15px] font-semibold tracking-tight">AI-Hub</div>
          <div className="text-[11.5px] text-muted">One machine, many accounts</div>
        </div>
        <nav className="no-drag flex flex-col gap-0.5">
          {PAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => setPage(p.id)}
              className={`rounded-md px-2 py-1.5 text-left transition ${page === p.id ? 'bg-panel shadow-sm' : 'hover:bg-line/50'}`}
            >
              <div className="font-medium">{p.label}</div>
              <div className="text-[11px] text-muted">{p.hint}</div>
            </button>
          ))}
        </nav>
        <div className="mt-auto px-2 text-[11px] leading-snug text-muted">
          Logins, MCP servers and history stay inside each profile. Only what you tick in Sharing is shared.
        </div>
        <VersionFooter status={updates.status} info={updates.info} notify={notify} onCliInstalled={updates.refreshInfo} />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-10 pb-12">
        <UpdateBanner status={updates.status} notify={notify} />
        {page === 'profiles' && <ProfilesPage notify={notify} />}
        {page === 'sharing' && <SharingPage notify={notify} />}
        {page === 'library' && <LibraryPage notify={notify} />}
        {page === 'health' && <HealthPage />}
      </main>
      <Toasts items={toasts} />
    </div>
  );
}
