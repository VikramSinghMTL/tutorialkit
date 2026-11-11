import { useStore } from '@nanostores/react';
import type { TutorialStore } from '@tutorialkit/runtime';
import type { I18n } from '@tutorialkit/types';
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { DialogProvider } from '../core/Dialog.js';
import type { Theme } from '../core/types.js';
import resizePanelStyles from '../styles/resize-panel.module.css';
import { classNames } from '../utils/classnames.js';
import { revealRequest, whatsNewFiles } from '../core/CodeMirrorEditor/line-marks.js';
import { EditorPanel } from './EditorPanel.js';
import { showConsoleTab } from './preview-bridge.js';
import { PreviewPanel, type ImperativePreviewHandle } from './PreviewPanel.js';
import { TerminalPanel } from './TerminalPanel.js';

const DEFAULT_TERMINAL_SIZE = 25;

// course patch: the editor and preview can shrink to a strip this tall
const MIN_SIZE_IN_PIXELS = 24;

/**
 * course patch: stops the preview iframes from swallowing the mouse while a divider is dragged.
 */
function onDividerDragging(isDragging: boolean) {
  document.documentElement.classList.toggle('tk-resizing', isDragging);
}

/**
 * course patch: lets the page confirm a reset first. The page cancels this event, asks the student,
 * and resets the lesson itself once they agree.
 */
function isResetAllowed() {
  return window.dispatchEvent(new Event('tutorialkit:reset-request', { cancelable: true }));
}

type FileTreeChangeEvent = Parameters<NonNullable<ComponentProps<typeof EditorPanel>['onFileTreeChange']>>[0];

interface Props {
  tutorialStore: TutorialStore;
  theme: Theme;
  dialog: NonNullable<ComponentProps<typeof DialogProvider>['value']>;
}

interface PanelProps extends Omit<Props, 'dialog'> {
  hasEditor: boolean;
  hasPreviews: boolean;
  hideTerminalPanel: boolean;
  panelMinSize?: number;
}

interface TerminalProps extends PanelProps {
  terminalPanelRef: React.RefObject<ImperativePanelHandle>;
  terminalExpanded: React.MutableRefObject<boolean>;
}

/**
 * This component is the orchestrator between various interactive components.
 */
export function WorkspacePanel({ tutorialStore, theme, dialog }: Props) {
  /**
   * Re-render when lesson changes.
   * The `tutorialStore.hasEditor()` and other methods below access
   * stale data as they are not reactive.
   */
  useStore(tutorialStore.ref);

  const hasEditor = tutorialStore.hasEditor();
  const hasPreviews = tutorialStore.hasPreviews();
  const hideTerminalPanel = !tutorialStore.hasTerminalPanel();

  const terminalPanelRef = useRef<ImperativePanelHandle>(null);
  const terminalExpanded = useRef(false);
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const [panelMinSize, setPanelMinSize] = useState(10);

  useEffect(() => {
    const panelGroup = document.querySelector('div[data-panel-group-id="right-panel-group"]' as 'div');

    if (!panelGroup) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const height = panelGroup?.offsetHeight;
      setPanelMinSize((MIN_SIZE_IN_PIXELS / height) * 100);
    });
    observer.observe(panelGroup);

    return () => {
      observer.disconnect();
    };
  }, []);

  // course patch: the corner handle in the main layout moves the editor/preview divider through this event
  useEffect(() => {
    function onResizeEditor(event: Event) {
      const panelGroup = document.querySelector('div[data-panel-group-id="right-panel-group"]' as 'div');
      const group = panelGroupRef.current;

      if (!panelGroup || !group) {
        return;
      }

      const { top, height } = panelGroup.getBoundingClientRect();
      const [, , terminal] = group.getLayout();
      const clientY = (event as CustomEvent<{ clientY: number }>).detail.clientY;
      const editor = Math.max(
        panelMinSize,
        Math.min(100 - terminal - panelMinSize, ((clientY - top) / height) * 100),
      );
      group.setLayout([editor, 100 - terminal - editor, terminal]);
    }

    window.addEventListener('tk:resize-editor', onResizeEditor);

    return () => window.removeEventListener('tk:resize-editor', onResizeEditor);
  }, [panelMinSize]);

  // course patch: tell the corner handle once the new layout is on the page, so it can follow the divider
  const [workspaceLayout, setWorkspaceLayout] = useState<number[]>([]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('tk:workspace-layout'));
  }, [workspaceLayout, hasEditor]);

  return (
    <PanelGroup
      ref={panelGroupRef}
      className={resizePanelStyles.PanelGroup}
      id="right-panel-group"
      direction="vertical"
      onLayout={setWorkspaceLayout}
    >
      <DialogProvider value={dialog}>
        <EditorSection
          theme={theme}
          tutorialStore={tutorialStore}
          hasEditor={hasEditor}
          hasPreviews={hasPreviews}
          hideTerminalPanel={hideTerminalPanel}
          panelMinSize={panelMinSize}
        />
      </DialogProvider>

      <PanelResizeHandle
        id="editor-preview-handle"
        className={resizePanelStyles.PanelResizeHandle}
        hitAreaMargins={{ fine: 5, coarse: 5 }}
        disabled={!hasEditor}
        onDragging={onDividerDragging}
      />

      <PreviewsSection
        theme={theme}
        tutorialStore={tutorialStore}
        terminalPanelRef={terminalPanelRef}
        terminalExpanded={terminalExpanded}
        hideTerminalPanel={hideTerminalPanel}
        hasPreviews={hasPreviews}
        hasEditor={hasEditor}
        panelMinSize={panelMinSize}
      />

      <PanelResizeHandle
        className={resizePanelStyles.PanelResizeHandle}
        hitAreaMargins={{ fine: 5, coarse: 5 }}
        disabled={hideTerminalPanel || !hasPreviews}
        onDragging={onDividerDragging}
      />

      <TerminalSection
        tutorialStore={tutorialStore}
        theme={theme}
        terminalPanelRef={terminalPanelRef}
        terminalExpanded={terminalExpanded}
        hideTerminalPanel={hideTerminalPanel}
        hasEditor={hasEditor}
        hasPreviews={hasPreviews}
      />
    </PanelGroup>
  );
}

function EditorSection({ theme, tutorialStore, hasEditor, panelMinSize }: PanelProps) {
  const selectedFile = useStore(tutorialStore.selectedFile);
  const currentDocument = useStore(tutorialStore.currentDocument);
  const lessonFullyLoaded = useStore(tutorialStore.lessonFullyLoaded);
  const editorConfig = useStore(tutorialStore.editorConfig);
  const storeRef = useStore(tutorialStore.ref);
  const files = useStore(tutorialStore.files);
  const projectDocuments = useStore(tutorialStore.documents);
  const workspaceFiles = (tutorialStore as any)._lessonTemplate ?? {};
  const templateDocuments = collectTemplateDocuments(workspaceFiles);
  const templateFiles = collectTemplateFilePaths(workspaceFiles);
  const allFiles = [
    ...files,
    ...templateFiles
      .filter((path) => !projectDocuments?.[path])
      .map((path) => ({ path, type: 'file' as const })),
  ];
  const templateDocument = selectedFile && !projectDocuments?.[selectedFile]
    ? templateDocuments[selectedFile]
      ? { filePath: selectedFile, value: templateDocuments[selectedFile], loading: false, readOnly: true }
      : templateFiles.includes(selectedFile)
        ? { filePath: selectedFile, value: new Uint8Array(), loading: false, readOnly: true }
        : undefined
    : undefined;

  const lesson = tutorialStore.lesson!;

  /*
   * course patch: Reset and Solve are separate buttons, so Reset is there even when a lesson has a solution.
   * Clicks while files are loading are ignored, which keeps the buttons' server and client markup the same.
   */
  function onReset() {
    if (!lessonFullyLoaded || !isResetAllowed()) return;

    tutorialStore.reset();
    window.dispatchEvent(new Event('tutorialkit:workspace-restored'));
  }

  function onSolve() {
    if (!lessonFullyLoaded) return;

    tutorialStore.solve();
    window.dispatchEvent(new Event('tutorialkit:workspace-restored'));
  }

  async function onFileTreeChange({ method, type, value }: FileTreeChangeEvent) {
    if (method === 'add' && type === 'file') {
      return tutorialStore.addFile(value);
    }

    if (method === 'add' && type === 'folder') {
      return tutorialStore.addFolder(value);
    }
  }

  useEffect(() => {
    // course patch: the page sends this lesson's "What's new" files once it has loaded them
    whatsNewFiles.set(undefined);
  }, [storeRef]);

  // course patch: console links and snippet titles open a file at some lines
  useEffect(() => {
    function onOpenFile(event: Event) {
      const { filePath, line, endLine } = (event as CustomEvent<{ filePath: string; line: number; endLine?: number }>)
        .detail;
      const documents = tutorialStore.documents.get();
      const workspace = (tutorialStore as any)._lessonTemplate ?? {};

      if (!documents[filePath] && findWorkspaceFile(workspace, filePath) === undefined) {
        return;
      }

      revealRequest.set({ filePath, line, endLine: endLine ?? line });
      openDefinition(tutorialStore, documents, workspace, filePath);
    }

    window.addEventListener('tutorialkit:open-file', onOpenFile);

    return () => window.removeEventListener('tutorialkit:open-file', onOpenFile);
  }, []);

  return (
    <Panel
      id={hasEditor ? 'editor-opened' : 'editor-closed'}
      defaultSize={hasEditor ? 50 : 0}
      minSize={panelMinSize}
      maxSize={hasEditor ? 100 : 0}
      collapsible={!hasEditor}
      className="transition-theme bg-tk-elements-panel-backgroundColor text-tk-elements-panel-textColor"
    >
      <EditorPanel
        id={storeRef}
        theme={theme}
        showFileTree={tutorialStore.hasFileTree()}
        editorDocument={currentDocument ?? templateDocument}
        files={files}
        allFiles={allFiles}
        projectDocuments={projectDocuments}
        workspaceFiles={workspaceFiles}
        i18n={lesson.data.i18n as I18n}
        hideRoot={lesson.data.hideRoot}
        hasSolution={tutorialStore.hasSolution()}
        onReset={onReset}
        onSolve={onSolve}
        onFileSelect={(filePath) => tutorialStore.setSelectedFile(filePath)}
        onFileTreeChange={onFileTreeChange}
        onDefinition={(filePath, line) => {
          // course patch: jump to the definition's line once its file is open
          const path = resolveFilePath(projectDocuments, workspaceFiles, filePath);

          if (path) {
            revealRequest.set({ filePath: path, line, endLine: line });
            openDefinition(tutorialStore, projectDocuments, workspaceFiles, path);
          }
        }}
        allowEditPatterns={editorConfig.fileTree.allowEdits || undefined}
        selectedFile={selectedFile}
        onEditorScroll={(position) => tutorialStore.setCurrentDocumentScrollPosition(position)}
        onEditorChange={(update) => {
          // CodeMirror also reports selection-only updates. Only notify consumers when
          // the document content itself has changed.
          if (tutorialStore.currentDocument.get()?.value !== update.content) {
            window.dispatchEvent(new Event('tutorialkit:editor-content-changed'));
          }

          tutorialStore.setCurrentDocumentContent(update.content);
        }}
      />
    </Panel>
  );
}

function collectTemplateDocuments(source: any, base = '', result: Record<string, string> = {}) {
  // Template audio/images belong in the preview workspace, not the editor file list.
  if (!source || source instanceof Uint8Array) return result;
  const entries = source instanceof Map ? [...source.entries()] : Array.isArray(source) ? source.map((value, index) => [String(index), value]) : typeof source === 'object' ? Object.entries(source) : [];
  for (const [name, value] of entries as [string, any][]) {
    if (value instanceof Uint8Array) continue;

    const path = value?.filePath ?? value?.path ?? (base ? `${base}/${name}` : name);
    const content = typeof value === 'string' ? value : value?.value ?? value?.content;
    if (typeof content === 'string' && !path.split('/').includes('challenges')) result[path] = content;
    else if (value && typeof value === 'object') collectTemplateDocuments(value, path, result);
  }
  return result;
}

function collectTemplateFilePaths(source: any, base = '', result: string[] = []): string[] {
  if (!source) return result;
  if (source instanceof Uint8Array) {
    if (!base.split('/').includes('challenges')) result.push(base);
    return result;
  }

  const entries = source instanceof Map ? [...source.entries()] : Array.isArray(source) ? source.map((value, index) => [String(index), value]) : typeof source === 'object' ? Object.entries(source) : [];
  for (const [name, value] of entries as [string, any][]) {
    const path = value?.filePath ?? value?.path ?? (base ? `${base}/${name}` : name);
    const content = typeof value === 'string' ? value : value?.value ?? value?.content;
    if (value instanceof Uint8Array || typeof content === 'string') {
      if (!path.split('/').includes('challenges')) result.push(path);
    } else if (value && typeof value === 'object') {
      collectTemplateFilePaths(value, path, result);
    }
  }
  return result;
}

function openDefinition(tutorialStore: TutorialStore, documents: any, workspace: any, filePath: string) {
  if (documents?.[filePath]) {
    tutorialStore.setSelectedFile(filePath);
    return;
  }
  const content = findWorkspaceFile(workspace, filePath);
  if (typeof content !== 'string') return;
  // Inherited template files are intentionally absent from the editable document map.
  // Materialize the target only when navigation asks for it.
  const editorStore = (tutorialStore as any)._editorStore;
  editorStore?.addFileOrFolder({ path: filePath, type: 'file' });
  editorStore?.updateFile(filePath, content);
  tutorialStore.setSelectedFile(filePath);
}
/**
 * course patch: TypeScript names files without the leading slash the editor's documents use, so try both.
 *
 * @returns The path the editor knows the file by, or nothing when it isn't in the lesson.
 */
function resolveFilePath(documents: any, workspace: any, filePath: string): string | undefined {
  const candidates = [filePath, filePath.startsWith('/') ? filePath.slice(1) : `/${filePath}`];

  return candidates.find((path) => documents?.[path] || findWorkspaceFile(workspace, path) !== undefined);
}

function findWorkspaceFile(source: any, target: string, base = ''): string | undefined {
  if (!source || source instanceof Uint8Array) return undefined;
  const entries = source instanceof Map ? [...source.entries()] : Array.isArray(source) ? source.map((value, index) => [String(index), value]) : typeof source === 'object' ? Object.entries(source) : [];
  for (const [name, value] of entries as [string, any][]) {
    if (value instanceof Uint8Array) continue;

    const path = value?.filePath ?? value?.path ?? (base ? `${base}/${name}` : name);
    const content = typeof value === 'string' ? value : value?.value ?? value?.content;
    if (path === target && typeof content === 'string') return content;
    if (value && typeof value === 'object') {
      const found = findWorkspaceFile(value, target, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function PreviewsSection({
  tutorialStore,
  terminalPanelRef,
  terminalExpanded,
  hideTerminalPanel,
  hasPreviews,
  hasEditor,
  panelMinSize,
}: TerminalProps) {
  const previewRef = useRef<ImperativePreviewHandle>(null);
  const lesson = tutorialStore.lesson!;
  const terminalConfig = useStore(tutorialStore.terminalConfig);
  const storeRef = useStore(tutorialStore.ref);

  function showTerminal() {
    const { current: terminal } = terminalPanelRef;

    if (!terminal) {
      return;
    }

    if (!terminalExpanded.current) {
      terminalExpanded.current = true;
      terminal.resize(DEFAULT_TERMINAL_SIZE);
    } else {
      terminal.expand();
    }
  }

  const showConsole = useCallback(() => {
    if (terminalPanelRef.current?.isCollapsed()) {
      showTerminal();
    }

    showConsoleTab();
  }, []);

  const toggleTerminal = useCallback(() => {
    if (terminalPanelRef.current?.isCollapsed()) {
      showTerminal();
    } else if (terminalPanelRef.current) {
      terminalPanelRef.current.collapse();
    }
  }, []);

  useEffect(() => {
    if (hideTerminalPanel) {
      // force hide the terminal if we don't have any panels to show
      terminalPanelRef.current?.collapse();

      terminalExpanded.current = false;
    }
  }, [hideTerminalPanel]);

  useEffect(() => {
    if (terminalConfig.defaultOpen) {
      showTerminal();
    }
  }, [terminalConfig.defaultOpen]);

  useEffect(() => {
    const lesson = tutorialStore.lesson!;

    const unsubscribe = tutorialStore.lessonFullyLoaded.subscribe((loaded) => {
      if (loaded && lesson.data.autoReload) {
        previewRef.current?.reload();
      }
    });

    return () => unsubscribe();
  }, [storeRef]);

  return (
    <Panel
      id={hasPreviews ? 'previews-opened' : 'previews-closed'}
      defaultSize={hasPreviews ? 50 : 0}
      minSize={panelMinSize}
      maxSize={hasPreviews ? 100 : 0}
      collapsible={!hasPreviews}
      className={classNames({
        'transition-theme border-t border-tk-elements-app-borderColor': hasEditor,
      })}
    >
      <PreviewPanel
        ref={previewRef}
        tutorialStore={tutorialStore}
        i18n={lesson.data.i18n as I18n}
        showToggleTerminal={!hideTerminalPanel}
        toggleTerminal={toggleTerminal}
        showConsole={showConsole}
      />
    </Panel>
  );
}

function TerminalSection({
  tutorialStore,
  theme,
  terminalPanelRef,
  terminalExpanded,
  hideTerminalPanel,
  hasEditor,
  hasPreviews,
}: TerminalProps) {
  let id = 'terminal-closed';

  if (hideTerminalPanel) {
    id = 'terminal-none';
  } else if (!hasPreviews && !hasEditor) {
    id = 'terminal-full';
  } else if (!hasPreviews) {
    id = 'terminal-opened';
  }

  let defaultSize = 0;

  if (hideTerminalPanel) {
    defaultSize = 0;
  } else if (!hasPreviews && !hasEditor) {
    defaultSize = 100;
  } else if (!hasPreviews) {
    defaultSize = DEFAULT_TERMINAL_SIZE;
  }

  return (
    <Panel
      id={id}
      defaultSize={defaultSize}
      minSize={hideTerminalPanel ? 0 : 10}
      collapsible={hasPreviews}
      ref={terminalPanelRef}
      onExpand={() => {
        terminalExpanded.current = true;
      }}
      className={classNames('transition-theme bg-tk-elements-panel-backgroundColor text-tk-elements-panel-textColor', {
        'border-t border-tk-elements-app-borderColor': hasPreviews,
      })}
    >
      <TerminalPanel tutorialStore={tutorialStore} theme={theme} />
    </Panel>
  );
}
