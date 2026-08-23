import { acceptCompletion, autocompletion, closeBrackets, startCompletion } from '@codemirror/autocomplete';
import { typeScriptCompletion, typeScriptDefinition, typeScriptDiagnostics, typeScriptHover, typeScriptSignature, updateTypeScriptProject, workspaceKey } from './typescript-vfs.js';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  scrollPastEnd,
  showTooltip,
} from '@codemirror/view';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { classNames } from '../../utils/classnames.js';
import { debounce } from '../../utils/debounce.js';
import type { Theme } from '../types.js';
import { BinaryContent } from './BinaryContent.js';
import { getTheme, reconfigureTheme } from './cm-theme.js';
import { indentKeyBinding } from './indent.js';
import { getLanguage } from './languages.js';

export interface EditorDocument {
  value: string | Uint8Array;
  loading: boolean;
  /** Inherited/template files are visible but cannot be edited. */
  readOnly?: boolean;
  filePath: string;
  scroll?: ScrollPosition;
}

export interface EditorSettings {
  fontSize?: string;
  tabSize?: number;
}

type TextEditorDocument = EditorDocument & {
  value: string;
};

export interface ScrollPosition {
  top: number;
  left: number;
}

export interface EditorUpdate {
  selection: EditorSelection;
  content: string;
}

export type OnChangeCallback = (update: EditorUpdate) => void;
export type OnScrollCallback = (position: ScrollPosition) => void;

interface Props {
  theme: Theme;
  id?: unknown;
  projectDocuments?: Record<string, { value: string | Uint8Array } | undefined> | Map<string, { value: string | Uint8Array }>;
  workspaceFiles?: unknown;
  projectFiles?: unknown;
  onDefinition?: (filePath: string) => void;
  doc?: EditorDocument;
  debounceChange?: number;
  debounceScroll?: number;
  autoFocusOnDocumentChange?: boolean;
  onChange?: OnChangeCallback;
  onScroll?: OnScrollCallback;
  className?: string;
  settings?: EditorSettings;
}

type EditorStates = Map<string, EditorState>;

export function CodeMirrorEditor({
  id,
  doc,
  projectDocuments = {},
  workspaceFiles = {},
  projectFiles = [],
  onDefinition,
  debounceScroll = 100,
  debounceChange = 150,
  autoFocusOnDocumentChange = false,
  onScroll,
  onChange,
  theme,
  settings,
  className = '',
}: Props) {
  const [language] = useState(new Compartment());
  const [readOnly] = useState(new Compartment());

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView>();
  const themeRef = useRef<Theme>();
  const docRef = useRef<EditorDocument>();
  const editorStatesRef = useRef<EditorStates>();
  const onScrollRef = useRef(onScroll);
  const onChangeRef = useRef(onChange);
  const typeScriptProjectRef = useRef<any>();
  const onDefinitionRef = useRef(onDefinition);

  const isBinaryFile = doc?.value instanceof Uint8Array;

  onScrollRef.current = onScroll;
  onChangeRef.current = onChange;
  onDefinitionRef.current = onDefinition;
  docRef.current = doc;
  themeRef.current = theme;

  useEffect(() => {
    const onUpdate = debounce((update: EditorUpdate) => {
      onChangeRef.current?.(update);
    }, debounceChange);

    const view = new EditorView({
      parent: containerRef.current!,
      dispatchTransactions(transactions) {
        const previousSelection = view.state.selection;

        view.update(transactions);

        const newSelection = view.state.selection;

        const selectionChanged =
          newSelection !== previousSelection &&
          (newSelection === undefined || previousSelection === undefined || !newSelection.eq(previousSelection));

        // Cache every transaction, including startCompletion's transaction. Otherwise a
        // debounced React render restores a pre-completion state and dismisses the menu.
        if (docRef.current) editorStatesRef.current!.set(docRef.current.filePath, view.state);

        if (
          docRef.current &&
          !docRef.current.loading &&
          (transactions.some((transaction) => transaction.docChanged) || selectionChanged)
        ) {
          onUpdate({
            selection: view.state.selection,
            content: view.state.doc.toString(),
          });
        }
      },
    });

    viewRef.current = view;

    // we grab the style tag that codemirror mounts
    const codemirrorStyleTag = document.head.children[0];
    codemirrorStyleTag.setAttribute('data-astro-transition-persist', 'codemirror');

    return () => {
      viewRef.current?.destroy();
      viewRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!viewRef.current) {
      return;
    }

    viewRef.current.dispatch({
      effects: [reconfigureTheme(theme)],
    });
  }, [theme]);

  useEffect(() => {
    editorStatesRef.current = new Map<string, EditorState>();
    typeScriptProjectRef.current = undefined;
  }, [id]);

  useEffect(() => {
    if (!doc || doc.value instanceof Uint8Array || !/\.tsx?$/i.test(doc.filePath)) return;
    typeScriptProjectRef.current?.languageService?.dispose();
    typeScriptProjectRef.current = undefined;
    updateTypeScriptProject(typeScriptProjectRef, projectDocuments, workspaceFiles, projectFiles, doc as TextEditorDocument);
  }, [id, doc?.filePath, workspaceKey(projectDocuments, workspaceFiles)]);

  useEffect(() => {
    const editorStates = editorStatesRef.current!;
    const view = viewRef.current!;
    const theme = themeRef.current!;

    if (!doc) {
      setNoDocument(view);
      return;
    }

    if (doc.value instanceof Uint8Array) {
      return;
    }

    const isTypeScript = /\.tsx?$/i.test(doc.filePath);
    if (isTypeScript) updateTypeScriptProject(typeScriptProjectRef, projectDocuments, workspaceFiles, projectFiles, doc as TextEditorDocument);
    let state = editorStates.get(doc.filePath);

    if (!state) {
      state = newEditorState(doc.value, theme, settings, onScrollRef, debounceScroll, [
        language.of([]),
        readOnly.of([EditorState.readOnly.of(doc.loading || !!doc.readOnly)]),
        ...(isTypeScript ? [
          // VFS member completion is configured explicitly. The source also includes
          // the normal TypeScript keywords, so it does not regress snippet completion.
          autocompletion({ closeOnBlur: false, override: [typeScriptCompletion(typeScriptProjectRef, doc.filePath)] }),
          linter(typeScriptDiagnostics(typeScriptProjectRef, doc.filePath), { delay: 350 }),
          hoverTooltip(typeScriptHover(typeScriptProjectRef, doc.filePath), { hideOnChange: true }),
          signatureHelp(typeScriptProjectRef, doc.filePath),
          keymap.of([{ key: 'F12', run: (view) => openDefinition(view, typeScriptProjectRef.current, doc.filePath, onDefinitionRef.current) }]),
          EditorView.domEventHandlers({
            click: (event, view) => {
              if (!event.metaKey && !event.ctrlKey) return false;
              const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (position == null) return false;
              event.preventDefault();
              view.dispatch({ selection: { anchor: position } });
              openDefinition(view, typeScriptProjectRef.current, doc.filePath, onDefinitionRef.current);
              return true;
            },
          }),
          EditorView.inputHandler.of((view, _from, _to, inserted) => { if (inserted === '.') requestAnimationFrame(() => startCompletion(view)); return false; }),
        ] : []),
      ]);

      editorStates.set(doc.filePath, state);
    }

    // React receives editor changes after a debounce. Re-applying the same state then
    // closes CodeMirror's completion popup, so only replace state for a real file switch.
    const stateChanged = view.state !== state;
    if (stateChanged) view.setState(state);

    if (stateChanged || doc.value !== view.state.doc.toString()) {
      setEditorDocument(view, theme, language, readOnly, autoFocusOnDocumentChange, doc as TextEditorDocument);
    }
  }, [doc?.value, doc?.filePath, doc?.loading, autoFocusOnDocumentChange]);

  return (
    <div className={classNames('relative', className)}>
      {isBinaryFile && <BinaryContent />}
      <div className="h-full overflow-hidden" ref={containerRef} />
    </div>
  );
}

export default CodeMirrorEditor;

CodeMirrorEditor.displayName = 'CodeMirrorEditor';

const setSignatureTooltip = StateEffect.define<any>();
const signatureTooltip = StateField.define<any>({
  create: () => null,
  update: (value, transaction) => transaction.effects.find((effect) => effect.is(setSignatureTooltip))?.value ?? (transaction.docChanged ? null : value),
  provide: (field) => showTooltip.from(field),
});
function signatureHelp(projectRef: { current: any }, filePath: string) {
  return [signatureTooltip, EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    requestAnimationFrame(() => {
      const info = typeScriptSignature(projectRef.current, filePath, update.view.state.doc.toString(), update.view.state.selection.main.head);
      const tooltip = !info ? null : {
        pos: update.view.state.selection.main.head,
        above: true,
        create() {
          const dom = document.createElement('pre');
          dom.className = 'cm-tooltip cm-tooltip-hover';
          dom.textContent = `${info.text}\n\nParameter ${info.activeParameter + 1}`;
          return { dom };
        },
      };
      update.view.dispatch({ effects: setSignatureTooltip.of(tooltip) });
    });
  })];
}

function openDefinition(view: EditorView, project: any, filePath: string, onDefinition?: (filePath: string) => void) {
  if (!onDefinition) return false;
  const definition = typeScriptDefinition(project, filePath, view.state.doc.toString(), view.state.selection.main.head);
  if (definition) onDefinition(definition);
  // Always consume F12: otherwise browsers open their developer tools when the
  // symbol has no local definition (for example, a standard-library symbol).
  return true;
}

function newEditorState(
  content: string,
  theme: Theme,
  settings: EditorSettings | undefined,
  onScrollRef: MutableRefObject<OnScrollCallback | undefined>,
  debounceScroll: number,
  extensions: Extension[],
) {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorView.contentAttributes.of({ 'aria-label': 'Editor' }),
      EditorView.baseTheme({
        '.cm-tooltip.cm-tooltip-hover': {
          maxWidth: 'min(42rem, calc(100vw - 2rem))',
          maxHeight: '16rem',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        },
      }),
      EditorView.domEventHandlers({
        scroll: debounce((_event, view) => {
          onScrollRef.current?.({ left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop });
        }, debounceScroll),
        keydown: (event) => {
          if (event.code === 'KeyS' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
          }
        },
      }),
      getTheme(theme, settings),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        { key: 'Tab', run: acceptCompletion },
        indentKeyBinding,
      ]),
      indentUnit.of('\t'),
      autocompletion({
        closeOnBlur: false,
      }),
      closeBrackets(),
      lineNumbers(),
      scrollPastEnd(),
      dropCursor(),
      drawSelection(),
      bracketMatching(),
      EditorState.tabSize.of(settings?.tabSize ?? 2),
      indentOnInput(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      foldGutter({
        markerDOM: (open) => {
          const icon = document.createElement('div');

          icon.className = `fold-icon ${open ? 'i-ph-caret-down-bold' : 'i-ph-caret-right-bold'}`;

          return icon;
        },
      }),
      ...extensions,
    ],
  });
}

function setNoDocument(view: EditorView) {
  view.dispatch({
    selection: { anchor: 0 },
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: '',
    },
  });

  view.scrollDOM.scrollTo(0, 0);
}

function setEditorDocument(
  view: EditorView,
  theme: Theme,
  language: Compartment,
  readOnly: Compartment,
  autoFocus: boolean,
  doc: TextEditorDocument,
) {
  if (doc.value !== view.state.doc.toString()) {
    view.dispatch({
      selection: { anchor: 0 },
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: doc.value,
      },
    });
  }

  view.dispatch({
    effects: [readOnly.reconfigure([EditorState.readOnly.of(doc.loading || !!doc.readOnly)])],
  });

  getLanguage(doc.filePath).then((languageSupport) => {
    if (!languageSupport) {
      return;
    }

    view.dispatch({
      effects: [language.reconfigure([languageSupport]), reconfigureTheme(theme)],
    });

    requestAnimationFrame(() => {
      const currentLeft = view.scrollDOM.scrollLeft;
      const currentTop = view.scrollDOM.scrollTop;
      const newLeft = doc.scroll?.left ?? 0;
      const newTop = doc.scroll?.top ?? 0;

      const needsScrolling = currentLeft !== newLeft || currentTop !== newTop;

      if (autoFocus) {
        if (needsScrolling) {
          // we have to wait until the scroll position was changed before we can set the focus
          view.scrollDOM.addEventListener(
            'scroll',
            () => {
              view.focus();
            },
            { once: true },
          );
        } else {
          // if the scroll position is still the same we can focus immediately
          view.focus();
        }
      }

      view.scrollDOM.scrollTo(newLeft, newTop);
    });
  });
}
