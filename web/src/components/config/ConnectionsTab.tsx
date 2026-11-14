import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type Connection } from '../../lib/configApi';
import { useStore } from '../../store';

/**
 * A bot's social circle: the bots it is friends with (connections go both ways) and the people
 * in your life it knows about. Bots add to it themselves as they learn; you can edit it here.
 */
export function ConnectionsTab({ bot }: { bot: Bot }) {
  const bots = useStore((s) => s.bots);
  const version = useStore((s) => s.socialVersion[bot.id] ?? 0);
  const [list, setList] = useState<Connection[] | null>(null);
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { configApi.connections(bot.id).then(setList).catch((e) => setError((e as Error).message)); }, [bot.id]);
  useEffect(() => { load(); }, [load, version]);

  const act = async (p: Promise<Connection[]>) => { setError(null); try { setList(await p); } catch (e) { setError((e as Error).message); } };
  const friends = (list ?? []).filter((c) => c.kind === 'bot');
  const people = (list ?? []).filter((c) => c.kind === 'person');
  const friendIds = new Set(friends.map((c) => c.otherBotId));
  const others = bots.filter((b) => b.id !== bot.id && b.kind !== 'room');

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Connections</div>
          <div className="cfg-page__sub">Who {bot.name} knows. Friends are Bots it works closely with; people are the folks in your life it should remember. {bot.name} adds to this on its own as you chat.</div>
        </div>
      </div>

      <div className="cfg-section__label">Bot friends</div>
      {others.length === 0 ? <div className="cfg-empty">Create another Bot to connect them.</div> : (
        <div className="conn-chips">
          {others.map((o) => {
            const on = friendIds.has(o.id);
            const conn = friends.find((c) => c.otherBotId === o.id);
            return (
              <button key={o.id} type="button" className={`conn-chip${on ? ' is-on' : ''}`} aria-pressed={on}
                onClick={() => act(on && conn ? configApi.removeConnection(bot.id, conn.id) : configApi.addConnection(bot.id, { kind: 'bot', otherBotId: o.id }))}>
                <BotAvatarFor bot={o} size={22} />
                <span>{o.name}</span>
                <span className="conn-chip__state">{on ? 'Friends' : 'Connect'}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="cfg-section__label">People</div>
      {!list ? <div className="cfg-empty">Loading…</div> : people.length === 0 ? <div className="cfg-empty">No one yet. Mention someone in chat (“my sister Ana loves hiking”) or add them here.</div> : (
        <div className="cfg-list">
          {people.map((p) => (
            <div key={p.id} className="cfg-row">
              <span className="conn-initial" aria-hidden>{p.name.slice(0, 1).toUpperCase()}</span>
              <div className="cfg-row__text">
                <div className="cfg-row__title">{p.name}{p.relation ? ` · ${p.relation}` : ''}</div>
                {p.note && <div className="cfg-row__sub">{p.note}</div>}
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => act(configApi.removeConnection(bot.id, p.id))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <form className="conn-form" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; act(configApi.addConnection(bot.id, { kind: 'person', name, relation, note })).then(() => { setName(''); setRelation(''); setNote(''); }); }}>
        <input className="text-input" placeholder="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <input className="text-input" placeholder="Relation, e.g. sister, client" value={relation} maxLength={60} onChange={(e) => setRelation(e.target.value)} aria-label="Relation" />
        <input className="text-input" placeholder="Something to remember (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!name.trim()}>Add person</button>
      </form>
      {error && <div className="cfg-error">{error}</div>}
    </div>
  );
}
