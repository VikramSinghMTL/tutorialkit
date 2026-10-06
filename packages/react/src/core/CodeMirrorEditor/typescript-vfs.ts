import { createDefaultMapFromCDN, createSystem, createVirtualTypeScriptEnvironment } from '@typescript/vfs';
import ts from 'typescript';

let libraries: Promise<Map<string, string>> | undefined;
let clearedLegacyLibraryCache = false;

function clearLegacyLibraryCache(): void {
  if (clearedLegacyLibraryCache) return;
  clearedLegacyLibraryCache = true;

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('ts-lib-')) localStorage.removeItem(key);
  }
}

// @typescript/vfs includes a few historical/future aliases that do not exist
// in TypeScript 5.6's CDN directory. Avoid issuing those known 404 requests.
const unavailableTypeScriptLibraries = new Set([
  'lib.core.d.ts',
  'lib.core.es6.d.ts',
  'lib.core.es7.d.ts',
  'lib.es7.d.ts',
  'lib.es2017.arraybuffer.d.ts',
]);

const SOURCE_FILE = /\.[jt]sx?$/i;
const CONFIG_FILE = /(^|\/)(jsconfig|tsconfig)\.json$/i;

// The editor fetches its own library files, so target and lib stay fixed
// whatever the project's config asks for.
const fixedCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  lib: ['lib.es2020.full.d.ts'],
};

const defaultCompilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: true,
};

/**
 * Reads compilerOptions (paths, checkJs, noImplicitAny, ...) from the root
 * jsconfig.json or tsconfig.json, so the editor resolves import aliases and
 * checks the same way the project's own type checker does.
 */
function projectCompilerOptions(...sources: unknown[]): ts.CompilerOptions {
  const config = collect(CONFIG_FILE, ...sources).sort((a, b) => a.path.length - b.path.length)[0];
  let options: ts.CompilerOptions = {};

  if (config) {
    const { config: json } = ts.parseConfigFileTextToJson(config.path, config.content);
    options = ts.convertCompilerOptionsFromJson(json?.compilerOptions ?? {}, '/').options;
  }

  // paths resolve against baseUrl; without one, use the project root.
  if (options.paths && !options.baseUrl) options.baseUrl = '/';

  return { ...defaultCompilerOptions, ...options, ...fixedCompilerOptions };
}

const fetchTypeScriptLibrary = async (url: string) => {
  const filename = url.split('/').at(-1);
  if (filename && unavailableTypeScriptLibraries.has(filename)) {
    return { json: async () => ({}), text: async () => '' };
  }
  return fetch(url);
};

export function updateTypeScriptProject(projectRef: { current: any }, documents: unknown, templates: unknown, files: unknown, active: { filePath: string; value: string }) {
  if (projectRef.current?.languageService) {
    const path = virtualPath(active.filePath);
    try { projectRef.current.updateFile(path, active.value); } catch { projectRef.current.createFile(path, active.value); }
    return;
  }
  const snapshot = { documents, templates, files, active };
  projectRef.current = snapshot;
  clearLegacyLibraryCache();
  // Keep TypeScript library files for this tab, without polluting site-wide localStorage.
  libraries ??= createDefaultMapFromCDN(
    { target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.full.d.ts'] },
    ts.version,
    true,
    ts,
    undefined,
    fetchTypeScriptLibrary,
    sessionStorage,
  );
  libraries.then((libs) => {
    if (projectRef.current !== snapshot) return;
    const map = new Map(libs);
    for (const file of collect(SOURCE_FILE, templates, files, documents)) map.set(virtualPath(file.path), file.content);
    map.set(virtualPath(active.filePath), active.value);
    projectRef.current = createVirtualTypeScriptEnvironment(createSystem(map), [...map.keys()].filter((path) => SOURCE_FILE.test(path)), ts, projectCompilerOptions(templates, files, documents));
  }).catch(() => { if (projectRef.current === snapshot) projectRef.current = undefined; });
}
export function typeScriptCompletion(projectRef: { current: any }, filePath: string) {
  const path = virtualPath(filePath);
  return (context: any) => {
    const project = projectRef.current;
    const word = context.matchBefore(/[\w$]*/);
    const member = /\.\s*$/.test(context.state.sliceDoc(0, context.pos));
    if (!context.explicit && (!word || word.from === word.to) && !member) return null;
    const keywords = member ? [] : ['if', 'else', 'for', 'while', 'function', 'return', 'class', 'const', 'let', 'import', 'export'].map((label) => ({ label, type: 'keyword' }));
    if (!project?.languageService) return keywords.length ? { from: word?.from ?? context.pos, options: keywords } : null;
    try {
      try { project.updateFile(path, context.state.doc.toString()); } catch { project.createFile(path, context.state.doc.toString()); }
      const entries = project.languageService.getCompletionsAtPosition(path, context.pos, {})?.entries ?? [];
      return { from: word?.from ?? context.pos, validFor: /^[\w$]*$/, options: [...entries.slice(0, 100).map((entry: any) => ({ label: entry.name, type: entry.kind })), ...keywords] };
    } catch { return keywords.length ? { from: word?.from ?? context.pos, options: keywords } : null; }
  };
}
export function typeScriptSignature(project: any, filePath: string, content: string, position: number) {
  if (!project?.languageService) return null;
  try {
    const path = virtualPath(filePath);
    try { project.updateFile(path, content); } catch { project.createFile(path, content); }
    const info = project.languageService.getSignatureHelpItems(path, position, {});
    if (!info) return null;
    const item = info.items[info.selectedItemIndex];
    return { text: `${ts.displayPartsToString(item.prefixDisplayParts)}${item.parameters.map((parameter: any) => ts.displayPartsToString(parameter.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts))}${ts.displayPartsToString(item.suffixDisplayParts)}`, activeParameter: info.argumentIndex };
  } catch { return null; }
}
export function typeScriptDefinition(project: any, filePath: string, content: string, position: number) {
  if (!project?.languageService) return null;
  try {
    const path = virtualPath(filePath);
    try { project.updateFile(path, content); } catch { project.createFile(path, content); }
    const fileName = project.languageService.getDefinitionAtPosition(path, position)?.[0]?.fileName;
    if (!fileName || /(^|\/)lib\..*\.d\.ts$/.test(fileName)) return null;
    return fileName.replace(/^\//, '');
  } catch { return null; }
}
export function typeScriptHover(projectRef: { current: any }, filePath: string) {
  const path = virtualPath(filePath);
  return (view: any, position: number) => {
    const project = projectRef.current;
    if (!project?.languageService) return null;
    try {
      try { project.updateFile(path, view.state.doc.toString()); } catch { project.createFile(path, view.state.doc.toString()); }
      const info = project.languageService.getQuickInfoAtPosition(path, position);
      if (!info) return null;
      return {
        pos: info.textSpan.start,
        end: info.textSpan.start + info.textSpan.length,
        above: true,
        create() {
          const dom = document.createElement('pre');
          dom.className = 'cm-tooltip cm-tooltip-hover';
          dom.textContent = `${ts.displayPartsToString(info.displayParts)}${info.documentation?.length ? `\n\n${ts.displayPartsToString(info.documentation)}` : ''}`;
          return { dom };
        },
      };
    } catch { return null; }
  };
}
export function typeScriptDiagnostics(projectRef: { current: any }, filePath: string) {
  const path = virtualPath(filePath);
  return (view: any) => {
    const project = projectRef.current;
    if (!project?.languageService) return [];
    try {
      try { project.updateFile(path, view.state.doc.toString()); } catch { project.createFile(path, view.state.doc.toString()); }
      return [...project.languageService.getSyntacticDiagnostics(path), ...project.languageService.getSemanticDiagnostics(path)]
        .filter((diagnostic: any) => diagnostic.start != null)
        .map((diagnostic: any) => ({
          from: diagnostic.start,
          to: diagnostic.start + (diagnostic.length ?? 1),
          severity: (diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info') as 'error' | 'warning' | 'info', 
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        }));
    } catch { return []; }
  };
}
/** Build a dependency key from source and config files only; binary game assets can be megabytes. */
export function workspaceKey(...values: unknown[]) {
  return [...collect(SOURCE_FILE, ...values), ...collect(CONFIG_FILE, ...values)]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}:${file.content}`)
    .join('|');
}
function virtualPath(path: string) { return path.startsWith('/') ? path : `/${path}`; }
function collect(pattern: RegExp, ...sources: unknown[]) {
  const result = new Map<string, string>();
  const walk = (source: any, base = '') => {
    if (!source) return;
    const entries = source instanceof Map ? [...source.entries()] : Array.isArray(source) ? source.map((value, index) => [String(index), value]) : typeof source === 'object' ? Object.entries(source) : [];
    for (const [name, value] of entries as [string, any][]) {
      // Assets are retained for the preview, but they are irrelevant to TypeScript
      // and must never be enumerated byte-by-byte while the editor is rendering.
      if (value instanceof Uint8Array) continue;

      const path = value?.filePath ?? value?.path ?? (base ? `${base}/${name}` : name);
      const content = typeof value === 'string' ? value : value?.value ?? value?.content;
      if (pattern.test(path) && typeof content === 'string') result.set(path, content);
      else if (value && typeof value === 'object') walk(value, path);
    }
  };
  sources.forEach((source) => walk(source));
  return [...result].map(([path, content]) => ({ path, content }));
}
