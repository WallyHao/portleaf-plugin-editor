import { manifest } from './manifest.js';
import {
  Facet,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import GithubSlugger from 'github-slugger';
import type { Nodes, Root, Definition } from 'mdast';
import type { Plugin, PluginContext, Settings } from '@portleaf/core';
import { createMarkdownParser, type MarkdownParser } from '../shared/markdown-parser-client.js';
import './style.css';
import { isMarkdownFile } from '../shared/file-types.js';
import { markdownHtml } from '../shared/markdown-html.js';

const parsers = new WeakMap<PluginContext, MarkdownParser>();
export type MarkdownContext = {
  settings: Settings;
  parser?: MarkdownParser;
  report?(error: unknown): void;
  resourceKey?(): string | undefined;
  resource?(target: string): string | undefined;
  openLink?(target: string): void;
};
const context = Facet.define<MarkdownContext, MarkdownContext>({ combine: (values) => values[0] });
const setLive = StateEffect.define<boolean>();
const parsed = StateEffect.define<{ doc: Text; root: Root }>();
class ActiveRegion extends RangeValue {}
const activeRegion = new ActiveRegion();
type Presentation = {
  live: boolean;
  root?: Root;
  decorations: DecorationSet;
  generation: number;
  resource?: string;
  regions: RangeSet<ActiveRegion>;
  active: string;
};
// CommonMark splits HTML blocks at blank lines, including README wrappers.
function htmlGroupEnd(children: Nodes[], index: number): number | undefined {
  const first = children[index];
  if (first.type !== 'html' || !/^<div\b[^>]*>\s*$/i.test(first.value)) return;
  let depth = 1;
  for (let end = index + 1; end < children.length; end++) {
    const part = children[end];
    if (part.type !== 'html') break;
    for (const match of part.value.matchAll(/<\/?div\b[^>]*>/gi)) {
      if (/^<\//.test(match[0])) depth--;
      else if (!/\/\s*>$/.test(match[0])) depth++;
    }
    if (depth === 0) return end;
    if (depth < 0) break;
  }
}
function regions(root: Root, state: EditorState) {
  const ranges: ReturnType<ActiveRegion['range']>[] = [];
  function visit(node: Nodes) {
    const location = span(node);
    if (location && location.from < location.to) {
      ranges.push(activeRegion.range(location.from, location.to));
      if (node.type === 'listItem') {
        const prefix = /^(?:[-+*]|\d+[.)])[\t ]+(?:\[[ xX]\])?/.exec(
          state.sliceDoc(location.from, location.to),
        );
        if (prefix)
          ranges.push(activeRegion.range(location.from, location.from + prefix[0].length));
      }
      if (node.type === 'blockquote') {
        for (let line = state.doc.lineAt(location.from); line.from < location.to;) {
          const prefix = /^(?:[\t ]*>[\t ]?)+/.exec(line.text);
          if (prefix) ranges.push(activeRegion.range(line.from, line.from + prefix[0].length));
          if (line.to >= state.doc.length) break;
          line = state.doc.lineAt(line.to + 1);
        }
      }
    }
    if ('children' in node) {
      const children = node.children as Nodes[];
      if (state.facet(markdownHtml)) {
        for (let index = 0; index < children.length; index++) {
          const end = htmlGroupEnd(children, index);
          const from = span(children[index])?.from;
          const to = end === undefined ? undefined : span(children[end])?.to;
          if (end !== undefined && from !== undefined && to !== undefined) {
            ranges.push(activeRegion.range(from, to));
            index = end;
          }
        }
      }
      children.forEach(visit);
    }
  }
  visit(root);
  return RangeSet.of(ranges, true);
}
function activeSignature(state: EditorState, regions: RangeSet<ActiveRegion>) {
  const parts: string[] = [];
  for (const selection of state.selection.ranges)
    regions.between(selection.from, selection.to, (from, to) => {
      if (
        selection.empty
          ? selection.head >= from && selection.head < to
          : selection.from < to && selection.to > from
      )
        parts.push(from + ':' + to);
    });
  return parts.join(',');
}

type Span = { from: number; to: number };
const span = (node: Nodes): Span | undefined => {
  const from = node.position?.start.offset,
    to = node.position?.end.offset;
  return from === undefined || to === undefined ? undefined : { from, to };
};
const text = (node: Nodes): string =>
  'value' in node
    ? node.value
    : 'alt' in node
      ? (node.alt ?? '')
      : 'children' in node
        ? node.children.map((child) => text(child)).join('')
        : '';

export function safeMarkdownTarget(value: string): string | undefined {
  const target = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target.replace(/[\u0000-\u0020\u007f]/g, ''));
  if (scheme && !['https', 'http', 'mailto'].includes(scheme[1].toLowerCase())) return;
  if (!target || target.startsWith('//') || target.includes('\\')) return;
  return target;
}

export async function jumpToMarkdownHeading(view: EditorView, fragment: string) {
  if (!(await ensureParsed(view))) return false;
  const root = view.state.field(presentation, false)?.root;
  if (!root) return false;
  const slugger = new GithubSlugger();
  let found: number | undefined;
  function visit(node: Nodes) {
    if (node.type === 'heading' && slugger.slug(text(node)) === fragment) found = span(node)?.from;
    if ('children' in node) node.children.forEach((child) => visit(child));
  }
  visit(root);
  if (found === undefined) return false;
  view.dispatch({ selection: { anchor: found }, scrollIntoView: true });
  view.focus();
  return true;
}

function follow(view: EditorView, target: string, ctx: MarkdownContext) {
  const safe = safeMarkdownTarget(target);
  if (!safe) return;
  if (safe.startsWith('#')) {
    try {
      void jumpToMarkdownHeading(view, decodeURIComponent(safe.slice(1))).catch(
        ctx.report ?? console.error,
      );
    } catch {
      /* Keep malformed anchors as text. */
    }
  } else ctx.openLink?.(safe);
}

class Rendered extends WidgetType {
  constructor(
    readonly from: number,
    readonly source: string,
    readonly generation: number,
    readonly kind: string,
    readonly draw: (element: HTMLElement, view: EditorView) => void,
    readonly block = false,
  ) {
    super();
  }
  eq(other: Rendered) {
    return (
      this.source === other.source &&
      this.generation === other.generation &&
      this.kind === other.kind
    );
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? 'div' : 'span');
    element.className = `md-rendered md-${this.kind}`;
    element.dataset.sourceFrom = String(this.from);
    element.title = 'Click to edit Markdown source';
    this.draw(element, view);
    element.addEventListener('mousedown', (event) => {
      if ((event.target as HTMLElement).closest('button, a')) return;
      event.preventDefault();
      const from = view.posAtDOM(element);
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    });
    return element;
  }
  ignoreEvent() {
    return true;
  }
}

let katexModule: Promise<typeof import('katex')> | undefined;
function formula(element: HTMLElement, value: string, block: boolean, view?: EditorView) {
  katexModule ??= import('katex');
  void katexModule
    .then(({ default: katex }) => {
      if (!element.isConnected) return;
      katex.render(value, element, {
        output: 'mathml',
        displayMode: block,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        maxSize: 10,
        maxExpand: 1000,
      });
      view?.requestMeasure();
    })
    .catch((error) => {
      element.textContent = error instanceof Error ? error.message : String(error);
    });
}

function decorations(state: EditorState, root: Root, generation: number): DecorationSet {
  const ctx = state.facet(context);
  const ranges: ReturnType<Decoration['range']>[] = [];
  const hidden = new Set<string>();
  const definitions = new Map<string, Definition>();
  root.children.forEach((node) => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node);
  });
  const target = (node: Nodes) =>
    'url' in node
      ? node.url
      : 'identifier' in node
        ? definitions.get(node.identifier.toUpperCase())?.url
        : undefined;
  const active = ({ from, to }: Span) =>
    state.selection.ranges.some((range) =>
      range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
    );
  const mark = (
    from: number,
    to: number,
    className: string,
    attributes?: Record<string, string>,
  ) => {
    if (to > from) ranges.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    const key = `${from}:${to}`;
    if (to > from && !hidden.has(key)) {
      hidden.add(key);
      ranges.push(Decoration.replace({}).range(from, to));
    }
  };
  const widget = (
    node: Nodes,
    kind: string,
    draw: (element: HTMLElement, view: EditorView) => void,
    block = false,
  ) => {
    const location = span(node);
    if (!location || active(location)) return false;
    ranges.push(
      Decoration.replace({
        widget: new Rendered(
          location.from,
          state.sliceDoc(location.from, location.to),
          generation,
          kind,
          draw,
          block,
        ),
        block,
      }).range(location.from, location.to),
    );
    return true;
  };
  function inline(node: Nodes, parent: HTMLElement, view: EditorView) {
    if (node.type === 'inlineMath') {
      const element = document.createElement('span');
      element.className = 'md-math';
      formula(element, node.value, false, view);
      parent.append(element);
      return;
    }
    const tag = {
      strong: 'strong',
      emphasis: 'em',
      delete: 's',
      inlineCode: 'code',
      link: 'a',
      linkReference: 'a',
      break: 'br',
    }[node.type as string];
    const element = document.createElement(tag ?? 'span');
    const href = target(node);
    if (tag === 'a' && href && safeMarkdownTarget(href)) {
      element.dataset.mdLink = href;
      element.title = `${href} (Space m l to open)`;
    }
    if ('children' in node) node.children.forEach((child) => inline(child, element, view));
    else element.textContent = text(node);
    parent.append(element);
  }
  function image(node: Nodes, element: HTMLElement, view: EditorView) {
    const href = target(node),
      resource = href ? ctx.resource?.(href) : undefined;
    const alt = 'alt' in node ? (node.alt ?? '') : '';
    if (!resource) {
      element.textContent = alt ? `Image: ${alt}` : 'Image';
      return;
    }
    const img = document.createElement('img');
    img.src = resource;
    img.alt = alt;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      if (element.isConnected) view.requestMeasure();
    };
    img.onerror = () => {
      element.textContent = `Image unavailable${alt ? `: ${alt}` : ''}`;
      if (element.isConnected) view.requestMeasure();
    };
    element.append(img);
  }
  function visit(node: Nodes, parent?: Nodes) {
    const location = span(node);
    if (!location) return;
    const { from, to } = location;
    const raw = state.sliceDoc(from, to);
    const htmlRenderer = state.facet(markdownHtml);
    if (
      htmlRenderer &&
      (node.type === 'html' ||
        (node.type === 'paragraph' && node.children.some((child) => child.type === 'html')))
    ) {
      widget(
        node,
        'html',
        (element, view) =>
          htmlRenderer(
            raw,
            element,
            (target) => ctx.resource?.(target),
            (target) => follow(view, target, ctx),
            () => view.requestMeasure(),
          ),
        node.type === 'html' && parent?.type !== 'paragraph',
      );
      return;
    }
    if (['html', 'yaml', 'toml', 'definition'].includes(node.type)) return;
    if (node.type === 'code') {
      if (
        widget(
          node,
          'code',
          (element) => {
            const pre = document.createElement('pre'),
              code = document.createElement('code');
            code.textContent = node.value;
            pre.append(code);
            element.append(pre);
            if (node.lang) element.dataset.language = node.lang;
          },
          true,
        )
      )
        return;
      return;
    }
    if (node.type === 'math' || node.type === 'inlineMath') {
      widget(
        node,
        'math',
        (element, view) => formula(element, node.value, node.type === 'math', view),
        node.type === 'math',
      );
      return;
    }
    if (
      node.type === 'table' &&
      widget(
        node,
        'table',
        (element, view) => {
          const table = document.createElement('table');
          node.children.forEach((row, index) => {
            const tr = document.createElement('tr');
            row.children.forEach((cell, column) => {
              const td = document.createElement(index === 0 ? 'th' : 'td');
              td.style.textAlign = node.align?.[column] ?? 'left';
              cell.children.forEach((child) => inline(child, td, view));
              tr.append(td);
            });
            table.append(tr);
          });
          element.append(table);
        },
        true,
      )
    )
      return;
    if (node.type === 'table') return;
    if (node.type === 'image' || node.type === 'imageReference') {
      widget(
        node,
        'image',
        (element, view) => image(node, element, view),
        parent?.type === 'paragraph' &&
          parent.children.length === 1 &&
          state.doc.lineAt(from).from === from,
      );
      return;
    }
    if (node.type === 'thematicBreak') {
      widget(node, 'rule', () => {}, true);
      return;
    }
    if (node.type === 'heading') {
      ranges.push(Decoration.line({ class: 'md-heading' }).range(state.doc.lineAt(from).from));
      if (!active(location)) {
        const opening = /^#{1,6}[\t ]+/.exec(raw);
        if (opening) {
          hide(from, from + opening[0].length);
          const closing = /[\t ]+#+[\t ]*$/.exec(raw);
          if (closing) hide(to - closing[0].length, to);
        } else hide(state.doc.lineAt(from).to, to);
      }
    }
    if (['strong', 'emphasis', 'delete', 'inlineCode'].includes(node.type)) {
      const size =
        node.type === 'inlineCode'
          ? /^`+/.exec(raw)![0].length
          : node.type === 'delete'
            ? /^~+/.exec(raw)![0].length
            : node.type === 'emphasis'
              ? 1
              : 2;
      mark(from + size, to - size, `md-${node.type}`);
      if (!active(location)) {
        hide(from, from + size);
        hide(to - size, to);
      }
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      const href = target(node),
        first = node.children[0],
        last = node.children.at(-1);
      const labelFrom = first ? span(first)?.from : undefined,
        labelTo = last ? span(last)?.to : undefined;
      if (href && safeMarkdownTarget(href) && labelFrom !== undefined && labelTo !== undefined) {
        mark(labelFrom, labelTo, 'md-link', {
          'data-md-link': href,
          title: `${href} (Space m l to open)`,
        });
        if (!active(location)) {
          hide(from, labelFrom);
          hide(labelTo, to);
        }
      }
    }
    if (node.type === 'blockquote') {
      for (let line = state.doc.lineAt(from); line.from < to;) {
        ranges.push(Decoration.line({ class: 'md-quote' }).range(line.from));
        const prefix = /^(?:[\t ]*>[\t ]?)+/.exec(line.text);
        if (prefix && !active({ from: line.from, to: line.from + prefix[0].length }))
          hide(line.from, line.from + prefix[0].length);
        if (line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }
    }
    if (node.type === 'listItem') {
      const prefix = /^([-+*]|\d+[.)])([\t ]+)/.exec(raw);
      if (prefix) {
        const task =
          typeof node.checked === 'boolean'
            ? /^\[[ xX]\]/.exec(raw.slice(prefix[0].length))
            : undefined;
        const end = from + (task ? prefix[0].length + task[0].length : prefix[1].length);
        if (!active({ from, to: end }) && (task || /^[-+*]$/.test(prefix[1]))) {
          ranges.push(
            Decoration.replace({
              widget: new Rendered(from, raw, generation, 'bullet', (element, view) => {
                if (!task) {
                  element.textContent = '•';
                  return;
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('role', 'checkbox');
                button.setAttribute('aria-checked', String(node.checked));
                button.setAttribute(
                  'aria-label',
                  node.checked ? 'Mark task incomplete' : 'Mark task complete',
                );
                button.textContent = node.checked ? '☑' : '☐';
                button.onmousedown = (event) => event.preventDefault();
                button.onclick = (event) => {
                  event.preventDefault();
                  if (view.state.readOnly || view.composing) return;
                  const start = view.posAtDOM(element);
                  const marker = /^(?:[-+*]|\d+[.)])[\t ]+\[([ xX])\]/.exec(
                    view.state.doc
                      .lineAt(start)
                      .text.slice(start - view.state.doc.lineAt(start).from),
                  );
                  if (!marker) return;
                  const at = start + marker[0].length - 2;
                  view.dispatch({
                    changes: { from: at, to: at + 1, insert: marker[1] === ' ' ? 'x' : ' ' },
                    userEvent: 'input',
                  });
                  view.focus();
                };
                element.append(button);
              }),
            }).range(from, end),
          );
        }
      }
    }
    if ('children' in node) {
      const children = node.children as Nodes[];
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const end = htmlRenderer ? htmlGroupEnd(children, index) : undefined;
        if (end !== undefined && child.position && children[end].position) {
          visit(
            {
              type: 'html',
              value: '',
              position: { start: child.position.start, end: children[end].position!.end },
            },
            node,
          );
          index = end;
          continue;
        }
        visit(child, node);
      }
    }
  }
  visit(root);
  return Decoration.set(ranges, true);
}

const presentation = StateField.define<Presentation>({
  create(state) {
    return {
      live: state.facet(context).settings.markdownMode !== 'source',
      decorations: Decoration.none,
      generation: 0,
      resource: state.facet(context).resourceKey?.(),
      regions: RangeSet.empty,
      active: '',
    };
  },
  update(value, transaction) {
    let live = value.live,
      root = transaction.docChanged ? undefined : value.root;
    let index = transaction.docChanged ? (RangeSet.empty as RangeSet<ActiveRegion>) : value.regions;
    for (const effect of transaction.effects) {
      if (effect.is(setLive)) live = effect.value;
      if (effect.is(parsed) && effect.value.doc === transaction.state.doc) {
        root = effect.value.root;
        index = regions(root, transaction.state);
      }
    }
    const resource = transaction.state.facet(context).resourceKey?.();
    const generation = value.generation + (resource !== value.resource ? 1 : 0);
    const active = root ? activeSignature(transaction.state, index) : '';
    let rendered = value.decorations;
    if (!live) rendered = Decoration.none;
    else if (root) {
      if (
        root !== value.root ||
        live !== value.live ||
        active !== value.active ||
        generation !== value.generation
      )
        rendered = decorations(transaction.state, root, generation);
    } else if (transaction.docChanged) {
      const changed: Span[] = [];
      transaction.changes.iterChangedRanges((from, to) => changed.push({ from, to }));
      rendered = rendered
        .update({
          filter: (from, to) =>
            !changed.some((change) =>
              change.from === change.to
                ? change.from > from && change.from < to
                : change.from < to && change.to > from,
            ),
        })
        .map(transaction.changes);
    }
    if (live && !root && (transaction.docChanged || transaction.selection)) {
      // Mapped widgets remain usable while the worker parses; the active line exposes its source.
      const lines = transaction.state.selection.ranges.map((selection) => ({
        from: transaction.state.doc.lineAt(selection.from).from,
        to: transaction.state.doc.lineAt(selection.to).to,
      }));
      rendered = rendered.update({
        filter: (from, to, decoration) =>
          !decoration.spec.widget || !lines.some((line) => from <= line.to && to >= line.from),
      });
    }
    return { live, root, regions: index, active, generation, resource, decorations: rendered };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.editorAttributes.from(field, (value) => ({
      'data-markdown-view': value.live ? 'live' : 'source',
    })),
  ],
});
export async function ensureParsed(view: EditorView, retry = true): Promise<boolean> {
  if (view.composing) return false;
  const value = view.state.field(presentation, false);
  if (!value) return false;
  if (value.root) return true;
  const doc = view.state.doc,
    parser = view.state.facet(context).parser!;
  const root = await parser.parse(doc.toString());
  if (!view.dom.isConnected || view.composing) return false;
  if (view.state.doc !== doc) return retry ? ensureParsed(view) : false;
  if (!view.state.field(presentation, false)) return false;
  view.dispatch({
    effects: parsed.of({ doc, root }),
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}
const parsing = ViewPlugin.define((view) => {
  let timer: ReturnType<typeof setTimeout>,
    busy = false,
    destroyed = false,
    failed: Text | undefined;
  const schedule = (delay = 70) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (
        destroyed ||
        busy ||
        (!view.inView && typeof Worker !== 'undefined') ||
        failed === view.state.doc
      )
        return;
      const value = view.state.field(presentation);
      if (!value.live || value.root) return;
      busy = true;
      void ensureParsed(view, false)
        .catch((error) => {
          failed = view.state.doc;
          if (!destroyed) (view.state.facet(context).report ?? console.error)(error);
        })
        .finally(() => {
          busy = false;
          if (!destroyed && !view.state.field(presentation).root) schedule();
        });
    }, delay);
  };
  schedule(0);
  return {
    update(update) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(setLive)),
        )
      )
        schedule();
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
    },
  };
});

export const isMarkdownLive = (state: EditorState) =>
  state.field(presentation, false)?.live ?? false;
export function toggleMarkdownView(view: EditorView) {
  const value = view.state.field(presentation, false);
  if (!value || view.composing) return false;
  view.dispatch({
    effects: [view.scrollSnapshot(), setLive.of(!value.live)],
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}

export async function followMarkdownLink(view: EditorView) {
  if (!(await ensureParsed(view))) return false;
  const root = view.state.field(presentation, false)?.root;
  if (!root || view.composing) return false;
  let href: string | undefined;
  const definitions = new Map(
    root.children
      .filter((node): node is Definition => node.type === 'definition')
      .map((node) => [node.identifier.toUpperCase(), node.url]),
  );
  function visit(node: Nodes) {
    const range = span(node);
    if (
      !range ||
      view.state.selection.main.head < range.from ||
      view.state.selection.main.head >= range.to
    )
      return;
    if (node.type === 'link' || node.type === 'linkReference')
      href = 'url' in node ? node.url : definitions.get(node.identifier.toUpperCase());
    if ('children' in node) node.children.forEach(visit);
  }
  visit(root);
  if (!href || !safeMarkdownTarget(href)) return false;
  follow(view, href, view.state.facet(context));
  return true;
}

export async function toggleMarkdownTask(view: EditorView) {
  if (view.state.readOnly || !(await ensureParsed(view))) return false;
  const root = view.state.field(presentation, false)?.root;
  if (!root || view.state.readOnly || view.composing) return false;
  let marker: number | undefined;
  function visit(node: Nodes) {
    const range = span(node);
    if (
      !range ||
      view.state.selection.main.head < range.from ||
      view.state.selection.main.head >= range.to
    )
      return;
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const prefix = /^(?:[-+*]|\d+[.)])[\t ]+\[([ xX])\]/.exec(
        view.state.sliceDoc(range.from, range.to),
      );
      if (prefix) marker = range.from + prefix[0].length - 2;
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(root);
  if (marker === undefined) return false;
  view.dispatch({
    changes: {
      from: marker,
      to: marker + 1,
      insert: view.state.sliceDoc(marker, marker + 1) === ' ' ? 'x' : ' ',
    },
    userEvent: 'input',
  });
  return true;
}

export function markdownPresentation(ctx: MarkdownContext) {
  const parser = ctx.parser ?? createMarkdownParser();
  return [
    context.of({ ...ctx, parser }),
    presentation,
    parsing,
    ...(ctx.parser ? [] : [ViewPlugin.define(() => ({ destroy: () => parser.destroy() }))]),
  ];
}

export const markdownVisualPlugin: Plugin = {
  ...manifest,
  activate(ctx) {
    const parser = createMarkdownParser();
    parsers.set(ctx, parser);
    ctx.onDispose(() => {
      parsers.delete(ctx);
      parser.destroy();
    });
    for (const [id, run] of [
      ['markdown.toggle', toggleMarkdownView],
      ['markdown.link', followMarkdownLink],
      ['markdown.task', toggleMarkdownTask],
    ] as const)
      ctx.registerCommand(id, async () => {
        const view = ctx.buffers.active()?.view;
        if (view) await run(view);
      });
    const button = document.createElement('button');
    button.className = 'viewmode';
    button.type = 'button';
    button.setAttribute('aria-label', 'Markdown view mode');
    button.title = 'Toggle Markdown view (Space m v)';
    button.onclick = () => {
      void ctx.commands.execute('markdown.toggle').catch(ctx.report);
      ctx.buffers.active()?.view?.focus();
    };
    ctx.status.append(button);
    const update = () => {
      const view = ctx.buffers.active()?.view;
      button.hidden = !isMarkdownFile(ctx.buffers.active()?.info?.path);
      button.textContent = view && isMarkdownLive(view.state) ? 'LIVE' : 'SOURCE';
    };
    ctx.onDispose(ctx.buffers.subscribe(update));
    ctx.onDispose(() => button.remove());
    update();
  },
  extension: ({ settings, app, buffer }) =>
    isMarkdownFile(buffer.info?.path)
      ? markdownPresentation({
          settings,
          parser: parsers.get(app),
          resourceKey: () => buffer.info?.path,
          report: app.report,
          resource: (target) => buffer.resource(target),
          openLink: (target) => {
            const file = buffer.info?.path;
            if (!file) return;
            void app.files
              .openLink(file, target)
              .then(async (result) => {
                if (!result || app.signal.aborted) return;
                await app.buffers.open(result.path);
                const view = app.buffers.active()?.view;
                if (view && result.fragment) await jumpToMarkdownHeading(view, result.fragment);
              })
              .catch(app.report);
          },
        })
      : [],
};
