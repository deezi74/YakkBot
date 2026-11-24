// Phone assistant: when YakkBot is the phone's digital assistant, the assist gesture (long-press the
// power or home button) opens the app and the page starts a voice conversation with your main bot.
// The Android app sets a flag (see android/.../Assistant.java); the page takes it here.
import { android } from './android';
import { useStore } from '../store';
import { speechSettings, startTalk, useTalk } from '../voice/talk';
import { isCallActive, startCall } from '../voice/call';

type AssistDroid = { takeAssist?(): boolean };

/** The bot the assistant talks as: the open one, else the main bot, else the first. */
function assistantBot(): string | null {
  const s = useStore.getState();
  if (s.selectedBotId && s.bots.some((b) => b.id === s.selectedBotId)) return s.selectedBotId;
  return (s.bots.find((b) => b.isPrimary) ?? s.bots[0])?.id ?? null;
}

async function startAssist(): Promise<void> {
  const d = android as (typeof android & AssistDroid) | undefined;
  if (!d?.takeAssist?.()) return;
  // The bots may still be loading right after the app opens.
  let id = assistantBot();
  for (let i = 0; !id && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    id = assistantBot();
  }
  if (!id) return;
  useStore.getState().selectBot(id, true);
  if (isCallActive() || useTalk.getState().status !== 'idle') return;
  // Same choice as the composer's talk button: Grok's realtime call when picked in Settings › Voice, else talk mode.
  const s = await speechSettings().catch(() => null);
  if (s?.voiceMode === 'realtime' && useStore.getState().features?.voice) startCall(id);
  else startTalk(id);
}

/** Start listening for the assist gesture. Returns a function that stops listening. */
export function watchAssist(): () => void {
  if (!android) return () => {};
  const on = () => { void startAssist(); };
  window.addEventListener('yakk:assist', on);
  on(); // the gesture may have opened the app before this page loaded
  return () => window.removeEventListener('yakk:assist', on);
}
