import { RangeSet, StateEffect, StateField, type Extension, type Range, type RangeValue, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from '@codemirror/view';
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

/** Lines the lesson took out since the previous lesson, with nothing put in their place. */
export interface RemovedLines {
  /** The line, from 1, whose edge the marker sits on. */
  line: number;

  /** `top` for a removal just above the line, `bottom` for one at the end of the file. */
  edge: 'top' | 'bottom';

  /** The removed lines, which the student can open in the editor. */
  lines: string[];
}

/**
 * Finds where the lesson took lines out of a file since the previous lesson, as the file is in the editor. A
 * changed line already gets a "What's new" bar, so only removals with nothing put in their place are marked, and
 * removed blank lines are left out.
 *
 * @param previous The file as the previous lesson started, or nothing for a new file.
 * @param current The file as this lesson starts.
 * @param shown The file as it is in the editor.
 * @returns Where to mark each removal.
 */
export function removedLines(previous: string | undefined, current: string, shown: string): RemovedLines[] {
  if (previous === undefined) {
    return [];
  }

  const previousLines = previous.split('\n');
  const currentLines = current.split('\n');
  const previousToCurrent = new Array<number>(previousLines.length).fill(-1);

  matchLines(previousLines, currentLines).forEach((match, index) => {
    if (match !== -1) {
      previousToCurrent[match] = index;
    }
  });

  const currentToShown = currentLines.map((_line, index) => index);

  if (current !== shown) {
    currentToShown.fill(-1);
    matchLines(currentLines, shown.split('\n')).forEach((match, index) => {
      if (match !== -1) {
        currentToShown[match] = index;
      }
    });
  }

  const marks: RemovedLines[] = [];
  let row = 0;
  let lastKept = -1;

  while (row < previousLines.length) {
    if (previousToCurrent[row] !== -1) {
      lastKept = previousToCurrent[row];
      row++;
      continue;
    }

    const start = row;

    while (row < previousLines.length && previousToCurrent[row] === -1) {
      row++;
    }

    const nextKept = row < previousLines.length ? previousToCurrent[row] : currentLines.length;
    const removed = previousLines.slice(start, row);
    const isReplaced = nextKept - lastKept > 1;

    if (isReplaced || removed.every((line) => line.trim() === '')) {
      continue;
    }

    const below = nextKept < currentLines.length ? currentToShown[nextKept] : -1;
    const above = lastKept >= 0 ? currentToShown[lastKept] : -1;

    if (below !== -1) {
      marks.push({ line: below + 1, edge: 'top', lines: removed });
    } else if (above !== -1) {
      marks.push({ line: above + 1, edge: 'bottom', lines: removed });
    }
  }

  return marks;
}

const setRevealedLines = StateEffect.define<{ from: number; to: number } | null>();
const setNewLines = StateEffect.define<{ added: number[]; removed: RemovedLines[] }>();
const toggleRemoved = StateEffect.define<number>();

/** A removal in the editor, which the student opens and closes from the gutter. */
interface RemovedBlock {
  id: number;

  /** Where the removed lines go: the start of the line below them, or the end of the file's last line. */
  position: number;
  edge: RemovedLines['edge'];
  lines: string[];
  isOpen: boolean;
}

const revealedLine = Decoration.line({ class: 'cm-tk-revealed-line' });
const newLineMarker = new (class extends GutterMarker {
  toDOM() {
    const bar = document.createElement('div');

    bar.className = 'cm-tk-new-line';

    return bar;
  }
})();

/**
 * @param count How many lines were removed.
 * @returns "1 removed line" or "N removed lines".
 */
function removedCount(count: number) {
  return count === 1 ? '1 removed line' : `${count} removed lines`;
}

/** A red wedge on the edge of a line where the lesson took lines out. Clicking it shows them. */
class RemovedMarker extends GutterMarker {
  constructor(
    readonly id: number,
    readonly edge: RemovedLines['edge'],
    readonly count: number,
  ) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RemovedMarker && other.id === this.id && other.edge === this.edge;
  }

  toDOM() {
    const wedge = document.createElement('div');
    const label = `Show ${removedCount(this.count)}`;

    wedge.className = `cm-tk-removed-lines cm-tk-removed-lines-${this.edge}`;
    wedge.dataset.removedId = String(this.id);
    wedge.title = label;
    wedge.setAttribute('aria-label', label);

    return wedge;
  }
}

/** The red bar beside open removed lines. Clicking it hides them again. */
class RemovedBarMarker extends GutterMarker {
  constructor(
    readonly id: number,
    readonly count: number,
  ) {
    super();
  }

  eq(other: GutterMarker) {
    return other instanceof RemovedBarMarker && other.id === this.id;
  }

  toDOM() {
    const bar = document.createElement('div');
    const label = `Hide ${removedCount(this.count)}`;

    bar.className = 'cm-tk-removed-bar';
    bar.dataset.removedId = String(this.id);
    bar.title = label;
    bar.setAttribute('aria-label', label);

    return bar;
  }
}

/** Removed lines shown read-only between the editor's lines, the way they were in the previous lesson. */
class RemovedWidget extends WidgetType {
  constructor(
    readonly id: number,
    readonly lines: string[],
  ) {
    super();
  }

  eq(other: RemovedWidget) {
    return other.id === this.id && other.lines === this.lines;
  }

  toDOM() {
    const block = document.createElement('div');

    block.className = 'cm-tk-removed-block';
    block.setAttribute('aria-label', 'Lines removed since the previous lesson');

    for (const line of this.lines) {
      const row = document.createElement('div');

      row.className = 'cm-tk-removed-row';
      row.textContent = line || '\u200b';
      block.append(row);
    }

    return block;
  }
}

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
        return RangeSet.of(lineRanges(transaction.state, effect.value.added, newLineMarker), true);
      }
    }

    return value.map(transaction.changes);
  },
});

const removedBlocks = StateField.define<RemovedBlock[]>({
  create: () => [],
  update(blocks, transaction) {
    let next = transaction.docChanged
      ? blocks.map((block) => ({
          ...block,
          position: transaction.changes.mapPos(block.position, block.edge === 'top' ? -1 : 1),
        }))
      : blocks;

    for (const effect of transaction.effects) {
      if (effect.is(setNewLines)) {
        const { doc } = transaction.state;

        next = effect.value.removed
          .filter(({ line }) => line >= 1 && line <= doc.lines)
          .map(({ line, edge, lines }, id) => ({
            id,
            position: edge === 'top' ? doc.line(line).from : doc.line(line).to,
            edge,
            lines,
            isOpen: false,
          }));
      } else if (effect.is(toggleRemoved)) {
        next = next.map((block) => (block.id === effect.value ? { ...block, isOpen: !block.isOpen } : block));
      }
    }

    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (blocks) =>
      Decoration.set(
        blocks
          .filter((block) => block.isOpen)
          .map((block) =>
            Decoration.widget({
              widget: new RemovedWidget(block.id, block.lines),
              block: true,
              side: block.edge === 'top' ? -1 : 1,
            }).range(block.position),
          ),
        true,
      ),
    ),
});

/**
 * Draws the "What's new" bars and the removal wedges in their own narrow gutter, so they sit apart from the line
 * numbers. It has no width while nothing is marked.
 */
const newLinesGutter = gutter({
  class: 'cm-tk-new-lines',
  markers: (view) => {
    const { doc } = view.state;
    const wedges = view.state
      .field(removedBlocks)
      .filter((block) => !block.isOpen)
      .map((block) => new RemovedMarker(block.id, block.edge, block.lines.length).range(doc.lineAt(block.position).from));

    return [view.state.field(newLines), RangeSet.of(wedges, true)];
  },
  widgetMarker: (_view, widget) =>
    widget instanceof RemovedWidget ? new RemovedBarMarker(widget.id, widget.lines.length) : null,
  domEventHandlers: {
    mousedown(view, _line, event) {
      const target = event.target as HTMLElement | null;
      const id = target?.closest<HTMLElement>('[data-removed-id]')?.dataset.removedId;

      if (id === undefined) {
        return false;
      }

      view.dispatch({ effects: toggleRemoved.of(Number(id)) });
      event.preventDefault();

      return true;
    },
  },
});

/**
 * @returns The editor extensions that draw the course's line marks.
 */
export function lineMarks(): Extension {
  return [
    revealedLines,
    newLines,
    removedBlocks,
    newLinesGutter,
    EditorView.baseTheme({
      '.cm-tk-revealed-line': { backgroundColor: 'rgba(250, 204, 21, 0.16)' },
      '.cm-tk-new-lines .cm-gutterElement': {
        position: 'relative',
        display: 'flex',
        boxSizing: 'border-box',
        width: '14px',
        paddingLeft: '6px',
      },
      '.cm-tk-new-line': { width: '3px', borderRadius: '1px', backgroundColor: '#22c55e' },
      '.cm-tk-removed-lines': {
        position: 'absolute',
        left: '6px',
        zIndex: '1',
        width: '0',
        height: '0',
        borderTop: '4px solid transparent',
        borderBottom: '4px solid transparent',
        borderLeft: '6px solid #ef4444',
        cursor: 'pointer',
      },
      '.cm-tk-removed-lines-top': { top: '-4px' },
      '.cm-tk-removed-lines-bottom': { bottom: '-4px' },
      '.cm-tk-removed-bar': { width: '3px', borderRadius: '1px', backgroundColor: '#ef4444', cursor: 'pointer' },
      '.cm-tk-removed-block': { backgroundColor: 'rgba(239, 68, 68, 0.12)', cursor: 'default' },
      '.cm-tk-removed-row': { padding: '0 2px 0 6px', whiteSpace: 'pre', opacity: '0.75' },
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
 * Marks the editor's lines that are new since the previous lesson and where lines were taken out, or clears the
 * marks.
 *
 * @param view The editor.
 * @param lines Line numbers, from 1.
 * @param removed Where lines were taken out.
 */
export function markNewLines(view: EditorView, lines: number[], removed: RemovedLines[] = []) {
  view.dispatch({ effects: setNewLines.of({ added: lines, removed }) });
}

if (globalThis.window) {
  // The page sends the previous and current lesson's starting files, or nothing for a tutorial's first lesson.
  window.addEventListener('tutorialkit:whats-new', (event) => {
    whatsNewFiles.set((event as CustomEvent<WhatsNewFiles | null>).detail ?? undefined);
  });
}
