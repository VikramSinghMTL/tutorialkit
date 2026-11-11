import { typescriptLanguage } from '@codemirror/lang-javascript';
import { highlightingFor } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { highlightTree } from '@lezer/highlight';

/**
 * course patch: the contents of the TypeScript hover and signature tooltips. Code is coloured by the editor's own
 * highlighter, so it matches the code in light and dark themes, and documentation reads as prose below it.
 */

/** A kind TypeScript puts before some descriptions, like "(property) " or "(method) ". */
const KIND_PREFIX = /^\(([\w ]+)\) /;

/**
 * @param view The editor the tooltip belongs to.
 * @param code TypeScript to show, like a type or a function's signature.
 * @returns The code, coloured like the editor and in the editor's font.
 */
function codeElement(view: EditorView, code: string): HTMLElement {
  const element = document.createElement('div');
  const contentStyle = getComputedStyle(view.contentDOM);
  const kind = KIND_PREFIX.exec(code);
  const source = kind ? code.slice(kind[0].length) : code;

  element.className = 'cm-tk-tooltip-code';
  element.style.fontFamily = contentStyle.fontFamily;
  element.style.fontSize = contentStyle.fontSize;

  if (kind) {
    const label = document.createElement('span');

    label.className = 'cm-tk-tooltip-kind';
    label.textContent = `(${kind[1]}) `;
    element.append(label);
  }

  let at = 0;

  const append = (to: number, classes: string) => {
    if (to <= at) {
      return;
    }

    const text = source.slice(at, to);

    if (classes) {
      const span = document.createElement('span');

      span.className = classes;
      span.textContent = text;
      element.append(span);
    } else {
      element.append(text);
    }

    at = to;
  };

  highlightTree(
    typescriptLanguage.parser.parse(source),
    { style: (tags) => highlightingFor(view.state, tags) },
    (from, to, classes) => {
      append(from, '');
      append(to, classes);
    },
  );
  append(source.length, '');

  return element;
}

/**
 * Builds a tooltip with highlighted code and, under it, plain documentation.
 *
 * @param view The editor the tooltip belongs to.
 * @param code TypeScript to show.
 * @param documentation Text to show under the code, if there is any.
 * @returns The tooltip's element.
 */
export function tooltipContent(view: EditorView, code: string, documentation?: string): HTMLElement {
  const dom = document.createElement('div');

  dom.className = 'cm-tooltip cm-tooltip-hover cm-tk-tooltip';
  dom.append(codeElement(view, code));

  if (documentation) {
    const docs = document.createElement('div');

    docs.className = 'cm-tk-tooltip-docs';
    docs.textContent = documentation;
    dom.append(docs);
  }

  return dom;
}

/** Styles for {@link tooltipContent}, added to the editor's base theme. */
export const tooltipTheme = {
  '.cm-tooltip.cm-tk-tooltip': { whiteSpace: 'normal', padding: '0' },
  '.cm-tk-tooltip-code': { padding: '4px 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  '.cm-tk-tooltip-kind': { opacity: '0.65' },
  '.cm-tk-tooltip-docs': {
    padding: '4px 8px 6px',
    borderTop: '1px solid var(--cm-tooltip-borderColor)',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: '13px',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
  },
};
