import { useStore } from '@nanostores/react';
import { useEffect, useRef, useState } from 'react';
import { classNames } from '../utils/classnames.js';
import {
  clearConsole,
  consoleEntries,
  openFileAt,
  type ConsoleEntry,
  type ConsoleLevel,
  type SourceLocation,
} from './preview-bridge.js';

/**
 * course patch: the Console tab, which lists what the game logged and threw. Each row links to the line that
 * logged it, and an error's stack links each frame in a project file.
 */

const LEVEL_STYLES: Record<ConsoleLevel, { icon: string; row: string }> = {
  log: { icon: 'i-ph-caret-right', row: '' },
  info: { icon: 'i-ph-info', row: '' },
  warn: { icon: 'i-ph-warning', row: 'tk-console-warn' },
  error: { icon: 'i-ph-x-circle', row: 'tk-console-error' },
};

interface Props {
  id: string;
  hidden: boolean;
  labelledBy: string;
}

export function ConsolePanel({ id, hidden, labelledBy }: Props) {
  const entries = useStore(consoleEntries);
  const listRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottom = useRef(true);

  // Keep showing the newest message, unless the student has scrolled up to read an older one.
  useEffect(() => {
    const list = listRef.current;

    if (list && isPinnedToBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [entries, hidden]);

  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      className={hidden ? 'hidden' : 'tk-console h-full flex flex-col text-sm'}
    >
      <div className="tk-console-toolbar flex items-center justify-between px-2 py-1 border-b border-tk-elements-app-borderColor">
        <span className="text-tk-elements-panel-headerTab-textColor">
          {entries.length === 0 ? 'Nothing logged yet.' : `${entries.length} message${entries.length === 1 ? '' : 's'}`}
        </span>
        <button className="panel-button px-2 py-0.5" onClick={clearConsole} disabled={entries.length === 0}>
          <div className="i-ph-prohibit" />
          Clear
        </button>
      </div>
      <div
        ref={listRef}
        className="flex-1 overflow-auto font-mono text-xs"
        onScroll={(event) => {
          const list = event.currentTarget;
          isPinnedToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        }}
      >
        {entries.map((entry) => (
          <ConsoleRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function ConsoleRow({ entry }: { entry: ConsoleEntry }) {
  const [showStack, setShowStack] = useState(entry.level === 'error');
  const style = LEVEL_STYLES[entry.level];
  const linkedFrames = entry.frames.filter((frame) => frame.location);

  return (
    <div className={classNames('tk-console-row px-2 py-1 border-b border-tk-elements-app-borderColor', style.row)}>
      <div className="flex items-start gap-2">
        <div className={classNames('shrink-0 mt-0.5', style.icon)} />
        {entry.count > 1 && (
          <span className="tk-console-count shrink-0" title={`Logged ${entry.count} times`}>
            {entry.count}
          </span>
        )}
        <span className="flex-1 whitespace-pre-wrap break-words">{entry.text}</span>
        {entry.location && <LocationLink location={entry.location} />}
        {entry.level === 'error' && linkedFrames.length > 1 && (
          <button
            className="tk-console-link shrink-0"
            onClick={() => setShowStack(!showStack)}
            aria-expanded={showStack}
          >
            {showStack ? 'Hide stack' : 'Stack'}
          </button>
        )}
      </div>
      {entry.level === 'error' && showStack && linkedFrames.length > 1 && (
        <ul className="tk-console-stack mt-1 ml-6 space-y-0.5">
          {linkedFrames.map((frame, index) => (
            <li key={index} className="flex gap-2">
              <span className="truncate opacity-70">{frame.text.replace(/\(?https?:\/\/[^\s)]+\)?/, '').trim()}</span>
              <LocationLink location={frame.location!} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LocationLink({ location }: { location: SourceLocation }) {
  const label = `${location.filePath.replace(/^\//, '')}:${location.line}`;

  return (
    <button
      className="tk-console-link shrink-0"
      title={`Open ${label} in the editor`}
      onClick={() => openFileAt(location.filePath, location.line)}
    >
      {label}
    </button>
  );
}
