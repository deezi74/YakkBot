import { useCallback, useEffect, useState } from 'react';
import { api, type Conversation } from '../lib/api';
import { relativeShort } from '../lib/time';
import { useStore } from '../store';
import { Icon } from './Icon';

/** Every conversation with the selected bot: start a new one, reopen an earlier one, or delete it. */
export function Conversations({ collapsed }: { collapsed: boolean }) {
  const botId = useStore((s) => s.selectedBotId);
  const bot = useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
  const t = useStore((s) => (s.selectedBotId ? s.transcripts[s.selectedBotId] : undefined));
  const set = useStore((s) => s.set);
  const [list, setList] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState(true);
  const rows = t ? Object.keys(t.bySeq).length : 0;
  const load = useCallback(() => { if (botId) api.conversations(botId).then(setList).catch(() => {}); }, [botId]);
  // Refresh when the bot changes, a conversation starts or reopens, and as messages arrive.
  useEffect(() => { const h = setTimeout(load, 400); return () => clearTimeout(h); }, [load, t?.generation, Math.floor(rows / 4)]);

  if (collapsed || !botId || !bot || bot.kind === 'room') return null;
  const go = (gen: number) => api.openConversation(botId, gen).then(() => { set({ mobilePane: 'chat' }); load(); }).catch(() => {});
  return (
    <div className="convs">
      <div className="convs__head">
        <button type="button" className="convs__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>Chats with {bot.name}</button>
        <button type="button" className="icon-btn" onClick={() => api.fresh(botId).then(() => { set({ mobilePane: 'chat' }); load(); })} aria-label="New chat" title="New chat">
          <Icon name="plus" size={16} />
        </button>
      </div>
      {open && (list ?? []).map((c) => (
        <div key={c.generation} className={`convs__item${c.current ? ' is-current' : ''}`}>
          <button type="button" className="convs__open" onClick={() => (c.current ? set({ mobilePane: 'chat' }) : go(c.generation))}>
            <span className="convs__title">{c.title}</span>
            <span className="convs__meta">{c.current ? 'Open now' : relativeShort(c.updatedAt)}{c.messages ? ` · ${c.messages} message${c.messages === 1 ? '' : 's'}` : ''}</span>
          </button>
          {!c.current && (
            <button type="button" className="convs__del" aria-label={`Delete “${c.title}”`} title="Delete"
              onClick={() => { if (confirm('Delete this conversation?')) api.deleteConversation(botId, c.generation).then(load).catch(() => {}); }}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
