import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark' | 'midnight' | 'ocean' | 'forest' | 'grape' | 'sunset' | 'amoled' | 'paper' | 'rose' | 'mint';

/** Color themes: each sits on the light or dark base and recolors the surfaces, bubbles and accent. */
export const PALETTES: Record<Exclude<Theme, 'system' | 'light' | 'dark'>, { label: string; base: 'light' | 'dark'; sidebar: string; pane: string; chrome: string; elevated: string; bubble: string; accent: string }> = {
  midnight: { label: 'Midnight', base: 'dark', sidebar: '#0B1020', pane: '#0F152B', chrome: '#0D1326', elevated: '#18203C', bubble: '#2A3A6E', accent: '#6C8CFF' },
  ocean: { label: 'Ocean', base: 'dark', sidebar: '#06171E', pane: '#0A2029', chrome: '#081C24', elevated: '#11303B', bubble: '#0F5566', accent: '#2EC4D6' },
  forest: { label: 'Forest', base: 'dark', sidebar: '#0A140E', pane: '#0F1C14', chrome: '#0C1811', elevated: '#18291E', bubble: '#1F5A36', accent: '#3DD68C' },
  grape: { label: 'Grape', base: 'dark', sidebar: '#140C1E', pane: '#1B1228', chrome: '#170F23', elevated: '#261A38', bubble: '#4B2B7A', accent: '#B07CFF' },
  sunset: { label: 'Sunset', base: 'dark', sidebar: '#1A0F0B', pane: '#221410', chrome: '#1E120D', elevated: '#2E1C15', bubble: '#7A3A1E', accent: '#FF8A4C' },
  amoled: { label: 'True black', base: 'dark', sidebar: '#000000', pane: '#000000', chrome: '#000000', elevated: '#111111', bubble: '#262626', accent: '#FFFFFF' },
  paper: { label: 'Paper', base: 'light', sidebar: '#F1EADB', pane: '#FBF6EC', chrome: '#F6F0E3', elevated: '#FFFDF8', bubble: '#E8DCC4', accent: '#9A6B2F' },
  rose: { label: 'Rose', base: 'light', sidebar: '#FBEAF0', pane: '#FFF7FA', chrome: '#FDF0F4', elevated: '#FFFFFF', bubble: '#F7CFDD', accent: '#E0457B' },
  mint: { label: 'Mint', base: 'light', sidebar: '#E6F5EE', pane: '#F7FCFA', chrome: '#EEF8F3', elevated: '#FFFFFF', bubble: '#C9EBDA', accent: '#14A06B' },
};
const PALETTE_VARS: Record<string, keyof (typeof PALETTES)['ocean']> = {
  '--color-bg-sidebar': 'sidebar', '--color-bg-pane': 'pane', '--color-bg-chrome': 'chrome', '--color-bg-elevated': 'elevated',
  '--color-bg-active-solid': 'elevated', '--color-bubble-user': 'bubble', '--color-border-focus': 'accent',
};
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'connections' | 'routines';
export type AppSection = 'general' | 'ai' | 'voice' | 'phone' | 'models' | 'computer' | 'permissions' | 'apps' | 'account';

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  view: 'chat' | 'tasks';
  theme: Theme;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  setView(v: 'chat' | 'tasks'): void;
  setTheme(t: Theme): void;
  bump(key: string): void;
}

const LS_THEME = 'yakkbot.theme';
const readTheme = (): Theme => {
  try { const t = localStorage.getItem(LS_THEME); return t === 'light' || t === 'dark' || (t && t in PALETTES) ? (t as Theme) : 'system'; } catch { return 'system'; }
};

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const pal = t in PALETTES ? PALETTES[t as keyof typeof PALETTES] : null;
  const resolved = pal ? pal.base : t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : (t as 'light' | 'dark');
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.palette = pal ? t : '';
  root.style.colorScheme = resolved;
  for (const [v, k] of Object.entries(PALETTE_VARS)) {
    if (pal) root.style.setProperty(v, pal[k]); else root.style.removeProperty(v);
  }
  // The phone's status bar and the app's top color follow the theme.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', pal ? pal.sidebar : resolved === 'dark' ? '#0E0E0E' : '#F5F5F5'));
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  view: 'chat',
  theme: readTheme(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'general') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    try { localStorage.setItem(LS_THEME, theme); } catch { /* ignore */ }
    applyTheme(theme);
    set({ theme });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('yakkbot:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
