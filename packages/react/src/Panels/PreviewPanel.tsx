import { useStore } from '@nanostores/react';
import type { PreviewInfo, TutorialStore } from '@tutorialkit/runtime';
import type { I18n } from '@tutorialkit/types';
import { reloadPreview } from '@webcontainer/api/utils';
import { createElement, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { BootScreen } from '../BootScreen.js';
import resizePanelStyles from '../styles/resize-panel.module.css';
import { classNames } from '../utils/classnames.js';
import {
  consoleErrorCount,
  debugState,
  hasDebugControls,
  resetPreviewBridge,
  sendDebug,
} from './preview-bridge.js';

interface Props {
  showToggleTerminal?: boolean;
  toggleTerminal?: () => void;
  /** course patch: opens the terminal panel on its Console tab. */
  showConsole?: () => void;
  tutorialStore: TutorialStore;
  i18n: I18n;
}

const previewsContainer = globalThis.document ? document.getElementById('previews-container')! : ({} as HTMLElement);

const MUTE_STORAGE_KEY = 'tk-preview-muted';
const MUTE_MESSAGE = 'tutorial:mute';
const MUTE_READY_MESSAGE = 'tutorial:mute-ready';

function readMuted() {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function sendMuted(target: MessageEventSource | Window | null | undefined, muted: boolean) {
  (target as Window | null | undefined)?.postMessage({ type: MUTE_MESSAGE, muted }, '*');
}

type IFrameRef = { ref: HTMLIFrameElement | undefined; container: HTMLElement | undefined };

export type ImperativePreviewHandle = {
  reload: () => void;
};

export const PreviewPanel = memo(
  forwardRef<ImperativePreviewHandle, Props>(({ showToggleTerminal, toggleTerminal, showConsole, i18n, tutorialStore }, ref) => {
    const expectedPreviews = useStore(tutorialStore.previews);
    const iframeRefs = useRef<IFrameRef[]>([]);
    const [muted, setMuted] = useState(readMuted);
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    const toggleMuted = useCallback(() => {
      const nowMuted = !mutedRef.current;
      mutedRef.current = nowMuted;
      setMuted(nowMuted);

      try {
        localStorage.setItem(MUTE_STORAGE_KEY, String(nowMuted));
      } catch {
        // the choice just won't persist across visits
      }

      for (const iframe of iframeRefs.current) {
        sendMuted(iframe.ref?.contentWindow, nowMuted);
      }
    }, []);

    useEffect(() => {
      // a preview announces itself each time it loads, so it gets the current mute state
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type !== MUTE_READY_MESSAGE) {
          return;
        }

        const fromPreview = iframeRefs.current.some((iframe) => iframe.ref?.contentWindow === event.source);

        if (fromPreview) {
          sendMuted(event.source, mutedRef.current);
        }
      };

      window.addEventListener('message', onMessage);

      return () => window.removeEventListener('message', onMessage);
    }, []);

    const onResize = useCallback(() => {
      for (const { ref, container } of iframeRefs.current) {
        if (!ref || !container) {
          continue;
        }

        const { left, top, width, height } = container.getBoundingClientRect();
        ref.style.left = `${left}px`;
        ref.style.top = `${top}px`;
        ref.style.height = `${height}px`;
        ref.style.width = `${width}px`;
      }
    }, []);

    const activePreviewsCount = expectedPreviews.reduce((count, preview) => (preview.ready ? count + 1 : count), 0);
    const hasPreviews = activePreviewsCount > 0;

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          resetPreviewBridge();

          for (const iframe of iframeRefs.current) {
            if (iframe.ref) {
              iframe.ref.src = iframe.ref.src;
            }
          }
        },
      }),
      [],
    );

    useEffect(() => {
      // we update the iframes position at max fps if we have any
      if (hasPreviews) {
        const cancel = requestAnimationFrameLoop(onResize);

        previewsContainer.style.display = 'block';

        return () => {
          previewsContainer.style.display = 'none';
          cancel();
        };
      }

      return undefined;
    }, [hasPreviews]);

    adjustLength(iframeRefs.current, activePreviewsCount, newIframeRef);
    preparePreviewsContainer(activePreviewsCount);

    // update preview refs
    for (const [index, iframeRef] of iframeRefs.current.entries()) {
      if (!iframeRef.ref) {
        iframeRef.ref = previewsContainer.children.item(index) as HTMLIFrameElement;
      }
    }

    if (!hasPreviews) {
      return (
        <div className="panel-container transition-theme bg-tk-elements-panel-backgroundColor text-tk-elements-panel-textColor">
          <div className="panel-header border-b border-tk-elements-app-borderColor justify-between">
            <div className="panel-title">
              <div className="panel-icon i-ph-lightning-duotone"></div>
              <span className="text-sm">{i18n.prepareEnvironmentTitleText}</span>
            </div>
            {showToggleTerminal && (
              <button
                className="panel-button px-2 py-0.5 -mr-1 -my-1"
                title="Toggle Terminal"
                onClick={() => toggleTerminal?.()}
              >
                <span className="panel-button-icon i-ph-terminal-window-duotone"></span>
                <span className="text-sm">{i18n.toggleTerminalButtonText}</span>
              </button>
            )}
          </div>
          <BootScreen tutorialStore={tutorialStore} />
        </div>
      );
    }

    const previews = expectedPreviews.filter((preview) => preview.ready);
    const defaultSize = 100 / previews.length;
    const minSize = 20;

    const children = [];

    for (const [index, preview] of previews.entries()) {
      children.push(
        <Panel defaultSize={defaultSize} minSize={minSize}>
          <Preview
            iframe={iframeRefs.current[index]}
            preview={preview}
            previewCount={previews.length}
            first={index === 0}
            last={index === previews.length - 1}
            toggleTerminal={toggleTerminal}
            i18n={i18n}
            tutorialStore={tutorialStore}
            muted={muted}
            toggleMuted={toggleMuted}
            showConsole={showConsole}
          />
        </Panel>,
      );

      if (index !== previews.length - 1) {
        children.push(<PanelResizeHandle className={resizePanelStyles.PanelResizeHandle} />);
      }
    }

    return createElement(PanelGroup, { direction: 'horizontal' }, ...children);
  }),
);
PreviewPanel.displayName = 'PreviewPanel';

interface PreviewProps {
  iframe: IFrameRef;
  preview: PreviewInfo;
  previewCount: number;
  first?: boolean;
  last?: boolean;
  toggleTerminal?: () => void;
  i18n: I18n;
  tutorialStore: TutorialStore;
  muted: boolean;
  toggleMuted: () => void;
  showConsole?: () => void;
}

function Preview({
  preview,
  iframe,
  previewCount,
  first,
  last,
  toggleTerminal,
  i18n,
  tutorialStore,
  muted,
  toggleMuted,
  showConsole,
}: PreviewProps) {
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const errorCount = useStore(consoleErrorCount);
  const showDebugControls = useStore(hasDebugControls);
  const debug = useStore(debugState);

  useEffect(() => {
    if (!iframe.ref) {
      return undefined;
    }

    iframe.container = previewContainerRef.current!;

    const frame = iframe.ref;
    const onLoad = () => setPreviewLoaded(true);

    setPreviewLoaded(false);
    resetPreviewBridge();
    frame.addEventListener('load', onLoad);

    if (preview.url) {
      frame.src = preview.url;
    }

    if (preview.title) {
      frame.title = preview.title;
    }

    return () => frame.removeEventListener('load', onLoad);
  }, [preview.url, iframe.ref]);

  function reload() {
    resetPreviewBridge();

    if (iframe.ref) {
      reloadPreview(iframe.ref);
    }
  }

  return (
    <div className="panel-container bg-tk-elements-panel-backgroundColor">
      <div
        className={classNames('panel-header border-b border-tk-elements-app-borderColor justify-between', {
          'border-l border-tk-elements-app-borderColor': !first,
        })}
      >
        <div className="panel-title">
          <button
            onClick={reload}
            title={i18n.reloadPreviewTitle}
            className="panel-button rounded-full p-1.5 -my-1.5 -ml-2"
          >
            <div className="panel-icon i-ph-arrow-clockwise"></div>
          </button>
          <button
            onClick={toggleMuted}
            title={muted ? 'Unmute preview' : 'Mute preview'}
            aria-label={muted ? 'Unmute preview' : 'Mute preview'}
            aria-pressed={muted}
            className="panel-button rounded-full p-1.5 -my-1.5"
          >
            <div className={muted ? 'panel-icon i-ph-speaker-slash' : 'panel-icon i-ph-speaker-high'}></div>
          </button>
          {showDebugControls && first && (
            <>
              <button
                onClick={() => sendDebug(debug.paused ? 'resume' : 'pause')}
                title={debug.paused ? 'Resume the game' : 'Pause the game'}
                aria-label={debug.paused ? 'Resume the game' : 'Pause the game'}
                aria-pressed={debug.paused}
                className="panel-button rounded-full p-1.5 -my-1.5"
              >
                <div className={debug.paused ? 'panel-icon i-ph-play' : 'panel-icon i-ph-pause'}></div>
              </button>
              <button
                onClick={() => sendDebug('step')}
                disabled={!debug.paused}
                title="Run one frame"
                aria-label="Run one frame"
                className="panel-button rounded-full p-1.5 -my-1.5 disabled:opacity-40"
              >
                <div className="panel-icon i-ph-skip-forward"></div>
              </button>
              <select
                value={debug.speed}
                onChange={(event) => sendDebug('speed', Number(event.target.value))}
                title="Game speed"
                aria-label="Game speed"
                className="tk-preview-speed -my-1"
              >
                <option value={0.25}>0.25×</option>
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
              </select>
              <button
                onClick={() => sendDebug('debug', !debug.debug)}
                title={debug.debug ? 'Hide the debug panel' : 'Show the debug panel'}
                aria-label={debug.debug ? 'Hide the debug panel' : 'Show the debug panel'}
                aria-pressed={debug.debug}
                className="panel-button rounded-full p-1.5 -my-1.5"
              >
                <div className="panel-icon i-ph-bug"></div>
              </button>
            </>
          )}
          <span className="text-sm truncate">{previewTitle(preview, previewCount, i18n)}</span>
          {errorCount > 0 && first && (
            <button
              onClick={() => showConsole?.()}
              title="Show the errors in the Console tab"
              className="tk-preview-error-badge -my-1"
            >
              <div className="i-ph-warning-circle-fill"></div>
              {errorCount === 1 ? '1 error' : `${errorCount} errors`}
            </button>
          )}
        </div>
        {last && (
          <button
            className="panel-button px-2 py-0.5 -mr-1 -my-1"
            title="Toggle Terminal"
            onClick={() => toggleTerminal?.()}
          >
            <div className="panel-button-icon i-ph-terminal-window-duotone"></div>
            <span className="text-sm">{i18n.toggleTerminalButtonText}</span>
          </button>
        )}
      </div>
      <div
        ref={previewContainerRef}
        className={classNames(
          'relative z-20 h-full w-full flex justify-center items-center bg-tk-elements-panel-backgroundColor',
          {
            'border-l border-tk-elements-previews-borderColor': !first,
          },
        )}
      >
        {!previewLoaded && <BootScreen className="absolute inset-0 z-20" tutorialStore={tutorialStore} />}
      </div>
    </div>
  );
}

function requestAnimationFrameLoop(loop: () => void): () => void {
  let handle: number;

  const callback = () => {
    loop();
    handle = requestAnimationFrame(callback);
  };

  handle = requestAnimationFrame(callback);

  return () => {
    cancelAnimationFrame(handle);
  };
}

function previewTitle(preview: PreviewInfo, previewCount: number, i18n: I18n) {
  if (preview.title) {
    return preview.title;
  }

  if (previewCount === 1) {
    return i18n.defaultPreviewTitleText;
  }

  return `Preview on port ${preview.port}`;
}

function preparePreviewsContainer(previewCount: number) {
  while (previewsContainer.childElementCount < previewCount) {
    const iframe = document.createElement('iframe');

    iframe.className = 'absolute z-10';

    iframe.allow =
      document.featurePolicy?.allowedFeatures().join('; ') ??
      'magnetometer; accelerometer; gyroscope; geolocation; microphone; camera; payment; autoplay; serial; xr-spatial-tracking; cross-origin-isolated';

    previewsContainer.appendChild(iframe);
  }

  for (let i = 0; i < previewsContainer.childElementCount; i++) {
    const preview = previewsContainer.children.item(i)!;

    if (i < previewCount) {
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
  }
}

function newIframeRef(): IFrameRef {
  return { ref: undefined, container: undefined };
}

function adjustLength<T>(array: T[], expectedSize: number, newElement: () => T) {
  while (array.length < expectedSize) {
    array.push(newElement());
  }

  while (array.length > expectedSize) {
    array.pop();
  }
}

declare global {
  interface Document {
    featurePolicy:
      | {
          allowedFeatures(): string[];
        }
      | undefined;
  }
}
