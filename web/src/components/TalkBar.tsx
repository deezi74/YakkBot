import type { CSSProperties } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { stopTalk, talkTap, useTalk } from '../voice/talk';
import { Icon } from './Icon';

const LABEL = { idle: '', listening: 'Listening…', sending: 'Got it…', thinking: 'Thinking…', speaking: 'Speaking…' } as const;

/** Talk mode's bar above the composer: who you are talking to, what is happening, and how to stop. */
export function TalkBar() {
  const t = useTalk();
  const bot = useStore((s) => s.bots.find((b) => b.id === t.botId));
  const selected = useStore((s) => s.selectedBotId);
  if (t.status === 'idle') {
    return t.error ? (
      <div className="talkbar is-error" role="alert">
        <span className="talkbar__text">{t.error}</span>
        <button type="button" className="talkbar__btn" onClick={() => useTalk.setState({ error: null })}>OK</button>
      </div>
    ) : null;
  }
  if (!bot || bot.id !== selected) return null;
  const tap = t.status === 'listening' ? 'Done talking' : t.status === 'speaking' ? 'Interrupt' : null;
  return (
    <div className={`talkbar is-${t.status}`} style={{ ...botVars(bot.avatarColor), ['--level' as string]: String(t.level) } as CSSProperties} role="status">
      <span className="talkbar__avatar"><BotAvatarFor bot={bot} size={30} /></span>
      <span className="talkbar__body">
        <span className="talkbar__state">{LABEL[t.status]}</span>
        {t.heard && <span className="talkbar__heard">“{t.heard}”</span>}
      </span>
      {tap && <button type="button" className="talkbar__btn" onClick={talkTap}>{tap}</button>}
      <button type="button" className="talkbar__end" onClick={stopTalk} aria-label="End talk mode" title="End talk mode"><Icon name="close" size={14} color="#FFFFFF" /></button>
    </div>
  );
}
