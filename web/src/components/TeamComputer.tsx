import { useEffect } from 'react';
import { ComputerScreen } from './ComputerViewer';
import { useStore } from '../store';
import { computerStatusText } from '../lib/computer';
import { Icon } from './Icon';

/**
 * The team's computer at a glance: one screen per Bot, side by side, each in its Bot's colored frame.
 * Opening a screen goes to that Bot's large view, where you can take control.
 */
export function TeamComputer() {
  const bots = useStore((s) => s.bots);
  const computer = useStore((s) => s.computer);
  const set = useStore((s) => s.set);
  const selectBot = useStore((s) => s.selectBot);
  const close = () => set({ teamComputerOpen: false });
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const max = computer?.maxScreens ?? 4;
  const withScreen = new Set(computer?.screens.map((s) => s.botId) ?? []);
  // Bots holding a screen first, then the rest until every screen is spoken for.
  const team = bots.filter((b) => b.kind !== 'room');
  const shown = [...team.filter((b) => withScreen.has(b.id)), ...team.filter((b) => !withScreen.has(b.id))].slice(0, Math.max(max, withScreen.size));

  return (
    <div className="team-computer" role="dialog" aria-modal="true" aria-label="Team computer">
      <div className="team-computer__top">
        <div>
          <div className="team-computer__title">Team computer</div>
          <div className="team-computer__sub">{computerStatusText(computer ?? null)} · {withScreen.size} of {max} screens in use</div>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close team computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>
      {shown.length === 0 ? <div className="team-computer__empty">Create a Bot to give it a screen.</div> : (
        <div className="team-computer__grid">
          {shown.map((b) => (
            <ComputerScreen
              key={b.id}
              bot={b}
              variant="panel"
              onExpand={(mode) => { selectBot(b.id, false); set({ teamComputerOpen: false, viewerOpen: true, viewerMode: mode, viewerHint: null }); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
