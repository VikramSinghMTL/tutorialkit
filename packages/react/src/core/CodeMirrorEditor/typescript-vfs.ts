import { createDefaultMapFromCDN, createSystem, createVirtualTypeScriptEnvironment } from '@typescript/vfs';
import ts from 'typescript';

let libraries: Promise<Map<string, string>> | undefined;
export function updateTypeScriptProject(projectRef: { current: any }, documents: unknown, templates: unknown, files: unknown, active: { filePath: string; value: string }) {
  if (projectRef.current?.languageService) {
    const path = virtualPath(active.filePath);
    try { projectRef.current.updateFile(path, active.value); } catch { projectRef.current.createFile(path, active.value); }
    return;
  }
  const snapshot = { documents, templates, files, active };
  projectRef.current = snapshot;
  libraries ??= createDefaultMapFromCDN({ target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.full.d.ts'] }, ts.version, true, ts);
  libraries.then((libs) => {
    if (projectRef.current !== snapshot) return;
    const map = new Map(libs);
    for (const file of collect(templates, files, documents)) map.set(virtualPath(file.path), file.content);
    map.set(virtualPath(active.filePath), active.value);
    projectRef.current = createVirtualTypeScriptEnvironment(createSystem(map), [...map.keys()].filter((path) => /\.tsx?$/i.test(path)), ts, { target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.full.d.ts'], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.ReactJSX });
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
export function workspaceKey(...values: unknown[]) { return values.map((value) => JSON.stringify(value)).join('|'); }
function virtualPath(path: string) { return path.startsWith('/') ? path : `/${path}`; }
function collect(...sources: unknown[]) {
  const result = new Map<string, string>();
  const walk = (source: any, base = '') => {
    if (!source) return;
    const entries = source instanceof Map ? [...source.entries()] : Array.isArray(source) ? source.map((value, index) => [String(index), value]) : typeof source === 'object' ? Object.entries(source) : [];
    for (const [name, value] of entries as [string, any][]) {
      const path = value?.filePath ?? value?.path ?? (base ? `${base}/${name}` : name);
      const content = typeof value === 'string' ? value : value?.value ?? value?.content;
      if (/\.tsx?$/i.test(path) && typeof content === 'string') result.set(path, content);
      else if (value && typeof value === 'object') walk(value, path);
    }
  };
  sources.forEach((source) => walk(source));
  return [...result].map(([path, content]) => ({ path, content }));
}
