import { atom } from 'nanostores';

/**
 * course patch: the page side of the messages a course template's preview sends and receives. A template that
 * announces `tutorial:console-ready` gets the Console tab, and one that announces `tutorial:debug-ready` gets the
 * debug buttons, so a template that hasn't been updated shows neither.
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

/** A place in a project file that a stack frame points at. */
export interface SourceLocation {
  /** Editor path, like `/src/objects/Board.js`. */
  filePath: string;
  line: number;
  column: number;
}

/** One stack frame, as text, and the project file it points at, if it points at one. */
export interface StackFrame {
  text: string;
  location?: SourceLocation;
}

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
  count: number;
  frames: StackFrame[];
  /** The first frame in a project file, which the row links to. */
  location?: SourceLocation;
}

export interface DebugState {
  paused: boolean;
  speed: number;
  debug: boolean;
}

export type DebugAction = 'pause' | 'resume' | 'step' | 'speed' | 'debug';

const CONSOLE_MESSAGE = 'tutorial:console';
const CONSOLE_READY_MESSAGE = 'tutorial:console-ready';
const DEBUG_MESSAGE = 'tutorial:debug';
const DEBUG_READY_MESSAGE = 'tutorial:debug-ready';
const DEBUG_VIEW_MESSAGE = 'tutorial:debug-view';
const MAX_ENTRIES = 500;
const LEVELS = new Set<string>(['log', 'info', 'warn', 'error']);
const DEFAULT_DEBUG_STATE: DebugState = { paused: false, speed: 1, debug: false };

// Vite serves project files at their own path, with an optional `?t=` cache buster, before `:line:column`.
const FRAME_URL = /https?:\/\/[^/\s)]+(\/[^?#\s):]+\.(?:[cm]?[jt]sx?))(?:\?[^\s):]*)?:(\d+):(\d+)/;

export const consoleEntries = atom<ConsoleEntry[]>([]);
export const consoleErrorCount = atom(0);
export const hasConsole = atom(false);
export const hasDebugControls = atom(false);
export const debugState = atom<DebugState>(DEFAULT_DEBUG_STATE);

/** Bumped to ask the terminal panel to show the Console tab. */
export const consoleTabRequest = atom(0);

let nextId = 1;

/**
 * @returns The preview iframes on the page.
 */
function previewFrames() {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('#previews-container iframe'));
}

/**
 * @param text One stack frame.
 * @returns The project file it points at, or nothing for a dependency or the browser.
 */
export function parseLocation(text: string): SourceLocation | undefined {
  const match = text.match(FRAME_URL);

  if (!match || match[1].includes('/node_modules/') || match[1].startsWith('/@')) {
    return undefined;
  }

  return { filePath: decodeURIComponent(match[1]), line: Number(match[2]), column: Number(match[3]) };
}

/**
 * @param stack A stack trace.
 * @returns Its frames, with the ones in project files resolved to an editor path and line.
 */
function parseStack(stack: unknown): StackFrame[] {
  if (typeof stack !== 'string') {
    return [];
  }

  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\w*Error\b/.test(line))
    .map((text) => ({ text, location: parseLocation(text) }));
}

/**
 * Empties the Console tab and forgets which controls the preview offered, as happens whenever the preview
 * reloads. A preview that comes back announces itself again.
 */
export function resetPreviewBridge() {
  consoleEntries.set([]);
  consoleErrorCount.set(0);
  hasConsole.set(false);
  hasDebugControls.set(false);
  debugState.set(DEFAULT_DEBUG_STATE);
}

/** Empties the Console tab and its error badge, as the Clear button does. */
export function clearConsole() {
  consoleEntries.set([]);
  consoleErrorCount.set(0);
}

/**
 * @returns Whether two locations are the same line of the same file, or both missing.
 */
function sameLocation(a: SourceLocation | undefined, b: SourceLocation | undefined) {
  return a?.filePath === b?.filePath && a?.line === b?.line;
}

/**
 * Adds a message to the Console tab, or bumps the count of the last row when it's the same message again.
 *
 * @param data The message's payload.
 */
function addConsoleEntry(data: { level?: unknown; args?: unknown; stack?: unknown; count?: unknown }) {
  const level = (LEVELS.has(String(data.level)) ? data.level : 'log') as ConsoleLevel;
  const text = Array.isArray(data.args) ? data.args.map(String).join(' ') : '';
  const count = Number.isInteger(data.count) && (data.count as number) > 0 ? (data.count as number) : 1;
  const frames = parseStack(data.stack);
  const location = frames.find((frame) => frame.location)?.location;
  const entries = consoleEntries.get();
  const last = entries.at(-1);

  if (level === 'error') {
    consoleErrorCount.set(consoleErrorCount.get() + count);
  }

  if (
    last &&
    last.level === level &&
    last.text === text &&
    sameLocation(location, last.location)
  ) {
    // The same line logging again, even from a different caller (the first frame starts from Game.start), is
    // one row. An error keeps the stack it first had.
    consoleEntries.set([...entries.slice(0, -1), { ...last, count: last.count + count }]);
    return;
  }

  consoleEntries.set([...entries, { id: nextId++, level, text, count, frames, location }].slice(-MAX_ENTRIES));
}

/**
 * Sends one debug control to every preview.
 *
 * @param action What to do.
 * @param value The speed, or whether the debug view shows.
 */
export function sendDebug(action: DebugAction, value?: number | boolean) {
  for (const frame of previewFrames()) {
    frame.contentWindow?.postMessage({ type: DEBUG_MESSAGE, action, value }, '*');
  }

  const state = debugState.get();

  if (action === 'pause' || action === 'resume') {
    debugState.set({ ...state, paused: action === 'pause' });
  } else if (action === 'speed' && typeof value === 'number') {
    debugState.set({ ...state, speed: value });
  } else if (action === 'debug' && typeof value === 'boolean') {
    debugState.set({ ...state, debug: value });
  }
}

/**
 * Opens a project file in the editor at a line, and highlights that line, or the lines up to `endLine`.
 *
 * @param filePath Editor path, like `/src/objects/Board.js`.
 * @param line First line, from 1.
 * @param endLine Last line to highlight.
 */
export function openFileAt(filePath: string, line: number, endLine = line) {
  window.dispatchEvent(new CustomEvent('tutorialkit:open-file', { detail: { filePath, line, endLine } }));
}

/** Asks the terminal panel to show the Console tab. */
export function showConsoleTab() {
  consoleTabRequest.set(consoleTabRequest.get() + 1);
}

if (globalThis.window) {
  window.addEventListener('message', (event: MessageEvent) => {
    const type = event.data?.type;

    if (
      typeof type !== 'string' ||
      !type.startsWith('tutorial:') ||
      !previewFrames().some((frame) => frame.contentWindow === event.source)
    ) {
      return;
    }

    if (type === CONSOLE_READY_MESSAGE) {
      clearConsole();
      hasConsole.set(true);
    } else if (type === CONSOLE_MESSAGE) {
      hasConsole.set(true);
      addConsoleEntry(event.data);
    } else if (type === DEBUG_READY_MESSAGE) {
      debugState.set(DEFAULT_DEBUG_STATE);
      hasDebugControls.set(true);
    } else if (type === DEBUG_VIEW_MESSAGE && typeof event.data.visible === 'boolean') {
      // The game can show its debug view itself, from a key or a menu, so the button follows it.
      debugState.set({ ...debugState.get(), debug: event.data.visible });
    }
  });
}
