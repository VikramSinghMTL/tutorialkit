import { RangeSet, StateEffect, StateField, type Extension, type Range, type RangeValue, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet } from '@codemirror/view';
import { atom } from 'nanostores';

/**
 * course patch: line marks the course draws in the editor. A reveal highlights the lines a console link or a lesson
 * snippet points at, and "What's new" marks the lines that changed since the previous lesson.
 */

/** A request to open a file at some lines, made by a console link or a snippet title. */
export interface RevealRequest {
  filePath: string;
  /** First line, from 1. */
  line: number;
  /** Last line, from 1. */
  endLine: number;
}

/** Starting files of the previous lesson and of this one, which "What's new" compares. */
export interface WhatsNewFiles {
  previous: Record<string, string | Uint8Array>;
  current: Record<string, string | Uint8Array>;
}

const WHATS_NEW_STORAGE_KEY = 'tk-whats-new';

export const revealRequest = atom<RevealRequest | undefined>(undefined);
export const whatsNewFiles = atom<WhatsNewFiles | undefined>(undefined);
export const whatsNewVisible = atom(readWhatsNewVisible());

/**
 * @returns Whether the student last left "What's new" on, which it is by default.
 */
function readWhatsNewVisible() {
  try {
    return globalThis.localStorage?.getItem(WHATS_NEW_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Shows or hides the "What's new" marks and remembers the choice.
 *
 * @param isVisible Whether the marks show.
 */
export function setWhatsNewVisible(isVisible: boolean) {
  whatsNewVisible.set(isVisible);

  try {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, String(isVisible));
  } catch {
    // the choice just won't last past this visit
  }
}

/**
 * @returns The paths of files that are new or changed since the previous lesson.
 */
export function changedFilePaths(files: WhatsNewFiles | undefined): Set<string> {
  const paths = new Set<string>();

  if (!files) {
    return paths;
  }

  for (const [path, value] of Object.entries(files.current)) {
    const previous = files.previous[path];

    if (previous === undefined || !sameContent(previous, value)) {
      paths.add(path);
    }
  }

  return paths;
}

/**
 * @returns Whether two files hold the same content.
 */
function sameContent(a: string | Uint8Array, b: string | Uint8Array) {
  if (typeof a === 'string' || typeof b === 'string') {
    return a === b;
  }

  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Matches the lines of `after` to the lines of `before` they came from, by the longest common subsequence.
 *
 * @param before Lines of the older text.
 * @param after Lines of the newer text.
 * @returns For each line of `after`, the index of its line in `before`, or -1 for a new or changed line.
 */
export function matchLines(before: string[], after: string[]): number[] {
  const matches = new Array<number>(after.length).fill(-1);
  let start = 0;
  let beforeEnd = before.length;
  let afterEnd = after.length;

  // Most edits touch a few lines, so the shared start and end are matched without the table.
  while (start < beforeEnd && start < afterEnd && before[start] === after[start]) {
    matches[start] = start;
    start++;
  }

  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
    matches[afterEnd] = beforeEnd;
  }

  const rows = beforeEnd - start;
  const columns = afterEnd - start;

  if (rows === 0 || columns === 0) {
    return matches;
  }

  const lengths = new Uint32Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;

  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[at(row, column)] =
        before[start + row] === after[start + column]
          ? lengths[at(row + 1, column + 1)] + 1
          : Math.max(lengths[at(row + 1, column)], lengths[at(row, column + 1)]);
    }
  }

  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (before[start + row] === after[start + column]) {
      matches[start + column] = start + row;
      row++;
      column++;
    } else if (lengths[at(row + 1, column)] >= lengths[at(row, column + 1)]) {
      row++;
    } else {
      column++;
    }
  }

  return matches;
}

/**
 * Finds the lines of a file the student sees that are new since the previous lesson. The lesson's own changes
 * are found first, then carried over to the file as the student has it, so their own edits aren't marked.
 *
 * @param previous The file as the previous lesson started, or nothing for a new file.
 * @param current The file as this lesson starts.
 * @param shown The file as it is in the editor.
 * @returns Line numbers, from 1, to mark.
 */
export function newLineNumbers(previous: string | undefined, current: string, shown: string): number[] {
  const currentLines = current.split('\n');
  const isNew =
    previous === undefined
      ? currentLines.map(() => true)
      : matchLines(previous.split('\n'), currentLines).map((match) => match === -1);
  const shownMatches = current === shown ? currentLines.map((_line, index) => index) : matchLines(currentLines, shown.split('\n'));

  return shownMatches.flatMap((match, index) => (match !== -1 && isNew[match] ? [index + 1] : []));
}

const setRevealedLines = StateEffect.define<{ from: number; to: number } | null>();
const setNewLines = StateEffect.define<number[]>();

const revealedLine = Decoration.line({ class: 'cm-tk-revealed-line' });
const newLineMarker = new (class extends GutterMarker {
  elementClass = 'cm-tk-new-line';
})();

/**
 * @returns The value placed at the start of each line, skipping lines past the end of the document.
 */
function lineRanges<T extends RangeValue>(state: { doc: Text }, lines: number[], value: T): Range<T>[] {
  return lines
    .filter((line) => line >= 1 && line <= state.doc.lines)
    .map((line) => value.range(state.doc.line(line).from));
}

const revealedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setRevealedLines)) {
        if (!effect.value) {
          return Decoration.none;
        }

        const lines: number[] = [];

        for (let line = effect.value.from; line <= effect.value.to; line++) {
          lines.push(line);
        }

        return Decoration.set(lineRanges(transaction.state, lines, revealedLine));
      }
    }

    // The highlight is a pointer to where to look, so it goes once the student types.
    return transaction.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const newLines = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setNewLines)) {
        return RangeSet.of(lineRanges(transaction.state, effect.value, newLineMarker), true);
      }
    }

    return value.map(transaction.changes);
  },
  provide: (field) => gutterLineClass.from(field),
});

/**
 * @returns The editor extensions that draw the course's line marks.
 */
export function lineMarks(): Extension {
  return [
    revealedLines,
    newLines,
    EditorView.baseTheme({
      '.cm-tk-revealed-line': { backgroundColor: 'rgba(250, 204, 21, 0.16)' },
      '.cm-lineNumbers .cm-gutterElement.cm-tk-new-line': { boxShadow: 'inset -3px 0 0 #22c55e' },
    }),
  ];
}

/**
 * Scrolls to some lines, puts the cursor at the first one and highlights them until the student types.
 *
 * @param view The editor.
 * @param line First line, from 1.
 * @param endLine Last line, from 1.
 */
export function revealLines(view: EditorView, line: number, endLine: number) {
  const first = Math.max(1, Math.min(line, view.state.doc.lines));
  const last = Math.max(first, Math.min(endLine, view.state.doc.lines));
  const position = view.state.doc.line(first).from;

  view.dispatch({
    selection: { anchor: position },
    effects: [
      setRevealedLines.of({ from: first, to: last }),
      EditorView.scrollIntoView(position, { y: 'center' }),
    ],
  });
  view.focus();
}

/**
 * Marks the editor's lines that are new since the previous lesson, or clears the marks.
 *
 * @param view The editor.
 * @param lines Line numbers, from 1.
 */
export function markNewLines(view: EditorView, lines: number[]) {
  view.dispatch({ effects: setNewLines.of(lines) });
}

if (globalThis.window) {
  // The page sends the previous and current lesson's starting files, or nothing for a tutorial's first lesson.
  window.addEventListener('tutorialkit:whats-new', (event) => {
    whatsNewFiles.set((event as CustomEvent<WhatsNewFiles | null>).detail ?? undefined);
  });
}
