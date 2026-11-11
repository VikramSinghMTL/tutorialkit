import { useStore } from '@nanostores/react';
import type { I18n } from '@tutorialkit/types';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import {
  CodeMirrorEditor,
  type EditorDocument,
  type OnChangeCallback as OnEditorChange,
  type OnScrollCallback as OnEditorScroll,
} from '../core/CodeMirrorEditor/index.js';
import {
  changedFilePaths,
  setWhatsNewVisible,
  whatsNewFiles,
  whatsNewVisible,
} from '../core/CodeMirrorEditor/line-marks.js';
import { FileTree } from '../core/FileTree.js';
import type { Theme } from '../core/types.js';
import resizePanelStyles from '../styles/resize-panel.module.css';
import { isMobile } from '../utils/mobile.js';

const DEFAULT_FILE_TREE_SIZE = 25;

interface Props {
  theme: Theme;
  id: unknown;
  files: ComponentProps<typeof FileTree>['files'];
  allFiles?: ComponentProps<typeof FileTree>['files'];
  projectDocuments?: Record<string, { value: string | Uint8Array } | undefined> | Map<string, { value: string | Uint8Array }>;
  workspaceFiles?: unknown;
  i18n: I18n;
  hideRoot?: boolean;
  fileTreeScope?: string;
  showFileTree?: boolean;
  hasSolution?: boolean;
  onReset?: () => void;
  onSolve?: () => void;
  editorDocument?: EditorDocument;
  selectedFile?: string | undefined;
  allowEditPatterns?: ComponentProps<typeof FileTree>['allowEditPatterns'];
  onEditorChange?: OnEditorChange;
  onEditorScroll?: OnEditorScroll;
  onFileSelect?: (value?: string) => void;
  onFileTreeChange?: ComponentProps<typeof FileTree>['onFileChange'];
  onDefinition?: (filePath: string, line: number) => void;
}

export function EditorPanel({
  theme,
  id,
  files,
  allFiles,
  projectDocuments,
  workspaceFiles,
  i18n,
  hideRoot,
  fileTreeScope,
  showFileTree = true,
  hasSolution,
  onReset,
  onSolve,
  editorDocument,
  selectedFile,
  allowEditPatterns,
  onEditorChange,
  onEditorScroll,
  onFileSelect,
  onFileTreeChange,
  onDefinition,
}: Props) {
  const fileTreePanelRef = useRef<ImperativePanelHandle>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const whatsNew = useStore(whatsNewFiles);
  const isWhatsNewVisible = useStore(whatsNewVisible);
  const changedFiles = useMemo(() => changedFilePaths(whatsNew), [whatsNew]);

  useEffect(() => {
    const { current: fileTreePanel } = fileTreePanelRef;

    if (!fileTreePanel) {
      return;
    }

    if (showFileTree) {
      if (fileTreePanel.isCollapsed()) {
        fileTreePanel.resize(DEFAULT_FILE_TREE_SIZE);
      }
    } else if (!showFileTree) {
      fileTreePanel.collapse();
    }
  }, [id]);

  return (
    <PanelGroup className="bg-tk-elements-panel-backgroundColor" direction="horizontal">
      <Panel className="flex flex-col" collapsible defaultSize={0} minSize={10} ref={fileTreePanelRef}>
        <div className="panel-header border-r border-b border-tk-elements-app-borderColor">
          <div className="panel-title">
            <div className="panel-icon i-ph-tree-structure-duotone shrink-0"></div>
            <span className="text-sm">{i18n.filesTitleText}</span>
          </div>
        </div>
        {!!allFiles && <label className="tk-show-all-files border-r border-b border-tk-elements-app-borderColor"><input type="checkbox" checked={showAllFiles} onChange={(event) => setShowAllFiles(event.target.checked)} /> Show all files</label>}
        <FileTree
          className="flex flex-col flex-grow py-2 border-r border-tk-elements-app-borderColor text-sm overflow-y-auto overflow-x-hidden"
          i18n={i18n}
          selectedFile={selectedFile}
          hideRoot={hideRoot ?? true}
          files={showAllFiles ? allFiles ?? files : files}
          scope={fileTreeScope}
          allowEditPatterns={allowEditPatterns}
          onFileSelect={onFileSelect}
          onFileChange={onFileTreeChange}
          markedFiles={isWhatsNewVisible ? changedFiles : undefined}
        />
      </Panel>
      <PanelResizeHandle
        disabled={!showFileTree}
        className={resizePanelStyles.PanelResizeHandle}
        hitAreaMargins={{ fine: 8, coarse: 8 }}
      />
      <Panel className="flex flex-col" defaultSize={100} minSize={10}>
        <FileTab
          i18n={i18n}
          editorDocument={editorDocument}
          hasSolution={hasSolution}
          onReset={onReset}
          onSolve={onSolve}
          hasWhatsNew={!!whatsNew}
          isWhatsNewVisible={isWhatsNewVisible}
        />
        <div className="h-full flex-1 overflow-hidden">
          <CodeMirrorEditor
            className="h-full"
            theme={theme}
            id={id}
            doc={editorDocument}
            projectDocuments={projectDocuments}
            workspaceFiles={workspaceFiles}
            projectFiles={files}
            onDefinition={onDefinition}
            autoFocusOnDocumentChange={!isMobile()}
            onScroll={onEditorScroll}
            onChange={onEditorChange}
          />
        </div>
      </Panel>
    </PanelGroup>
  );
}

interface FileTabProps {
  i18n: I18n;
  editorDocument: EditorDocument | undefined;
  hasSolution?: boolean;
  onReset?: () => void;
  onSolve?: () => void;
  hasWhatsNew: boolean;
  isWhatsNewVisible: boolean;
}

function FileTab({ i18n, editorDocument, hasSolution, onReset, onSolve, hasWhatsNew, isWhatsNewVisible }: FileTabProps) {
  const filePath = editorDocument?.filePath;
  const fileName = filePath?.split('/').at(-1) ?? '';
  const icon = fileName ? getFileIcon(fileName) : '';

  return (
    <div className="panel-header border-b border-tk-elements-app-borderColor flex justify-between">
      <div className="panel-title">
        <div className={`panel-icon scale-125 ${icon}`}></div>
        <span className="text-sm">{fileName}</span>
        {editorDocument?.readOnly && <span className="tk-readonly-badge">Read-only</span>}
      </div>
      <div className="flex-1" />
      {hasWhatsNew && (
        <button
          onClick={() => setWhatsNewVisible(!isWhatsNewVisible)}
          aria-pressed={isWhatsNewVisible}
          title={isWhatsNewVisible ? "Hide what's new since the last lesson" : "Show what's new since the last lesson"}
          className="panel-button px-2 py-0.5 -my-1"
        >
          <div className={isWhatsNewVisible ? 'i-ph-sparkle-fill text-lg' : 'i-ph-sparkle text-lg'} />
          What's new
        </button>
      )}
      <button
        onClick={() => window.dispatchEvent(new Event('tutorialkit:download-request'))}
        title="Download this lesson, with your edits, as a zip"
        className="panel-button px-2 py-0.5 -my-1"
      >
        <div className="i-ph-download-simple text-lg" />
        Download
      </button>
      {!!onReset && (
        <button onClick={onReset} className={`panel-button px-2 py-0.5 -my-1 ${hasSolution ? '' : '-mr-1'}`}>
          <div className="i-ph-clock-counter-clockwise-duotone" />
          {i18n.resetButtonText}
        </button>
      )}
      {hasSolution && !!onSolve && (
        <button onClick={onSolve} className="panel-button px-2 py-0.5 -mr-1 -my-1">
          <div className="i-ph-lightbulb-duotone text-lg" />
          {i18n.solveButtonText}
        </button>
      )}
    </div>
  );
}

function getFileIcon(fileName: string) {
  const extension = fileName.split('.').at(-1);

  if (!extension) {
    console.error('Cannot infer file type');
    return null;
  }

  switch (extension) {
    case 'ts': {
      return 'i-languages-ts?mask';
    }
    case 'cjs':
    case 'mjs':
    case 'js': {
      return 'i-languages-js?mask';
    }
    case 'html': {
      return 'i-languages-html?mask';
    }
    case 'css': {
      return 'i-languages-css?mask';
    }
    case 'scss':
    case 'sass': {
      return 'i-languages-sass?mask';
    }
    case 'md': {
      return 'i-languages-markdown?mask';
    }
    case 'json': {
      return 'i-languages-json?mask';
    }
    case 'gif':
    case 'jpg':
    case 'jpeg':
    case 'png': {
      return 'i-ph-image';
    }
    default: {
      return null;
    }
  }
}
