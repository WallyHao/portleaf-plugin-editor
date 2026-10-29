import type { Plugin } from '@portleaf/core';
import { isMarkdownFile } from '../shared/file-types.js';
import { markdownHtml, type HtmlRenderer } from '../shared/markdown-html.js';
import { manifest } from './manifest.js';
import './style.css';

// Build a fresh tree so document HTML cannot execute scripts or install event handlers.
const allowed = new Set([
  'div',
  'p',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  's',
  'del',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'picture',
  'source',
  'details',
  'summary',
  'kbd',
  'mark',
]);
const discarded = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form']);

const render: HtmlRenderer = (source, container, resource, follow, measure) => {
  const template = document.createElement('template');
  template.innerHTML = source;
  function copy(node: Node, parent: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ''));
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.localName;
    if (discarded.has(tag)) return;
    if (!allowed.has(tag)) {
      node.childNodes.forEach((child) => copy(child, parent));
      return;
    }
    const element = document.createElement(tag);
    for (const name of ['alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'open']) {
      const value = node.getAttribute(name);
      if (value !== null) element.setAttribute(name, value);
    }
    const align = node.getAttribute('align');
    if (align && ['left', 'right', 'center'].includes(align.toLowerCase()))
      element.style.textAlign = align.toLowerCase();
    if (tag === 'a') {
      const href = node.getAttribute('href');
      if (href) {
        element.classList.add('md-link');
        element.addEventListener('click', (event) => {
          event.preventDefault();
          follow(href);
        });
      }
    }
    if (tag === 'img' || tag === 'source') {
      const src = node.getAttribute(tag === 'img' ? 'src' : 'srcset');
      const url = src ? resource(src) : undefined;
      if (url) element.setAttribute(tag === 'img' ? 'src' : 'srcset', url);
      if (tag === 'source') {
        const media = node.getAttribute('media');
        if (media && /^\(prefers-color-scheme:\s*(?:dark|light)\)$/i.test(media))
          element.setAttribute('media', media);
      } else {
        element.setAttribute('loading', 'lazy');
        element.setAttribute('referrerpolicy', 'no-referrer');
        element.addEventListener('load', measure);
        element.addEventListener('error', measure);
      }
    }
    node.childNodes.forEach((child) => copy(child, element));
    parent.appendChild(element);
  }
  template.content.childNodes.forEach((node) => copy(node, container));
};

export const markdownHtmlPlugin: Plugin = {
  ...manifest,
  extension: ({ buffer }) => (isMarkdownFile(buffer.info?.path) ? markdownHtml.of(render) : []),
};
