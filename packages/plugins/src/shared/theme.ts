import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Theme } from '@portleaf/core';

export function editorTheme(palette: Theme) {
  return [
    EditorView.theme(
      { '&': { color: 'var(--foreground)', backgroundColor: 'var(--background)' } },
      { dark: palette.dark },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.heading, color: palette.colors.accent },
        { tag: tags.strong, fontWeight: 'bold' },
        { tag: tags.emphasis, fontStyle: 'italic' },
        { tag: [tags.link, tags.url], color: palette.colors.blue },
        {
          tag: [tags.monospace, tags.string, tags.regexp, tags.attributeValue],
          color: palette.colors.green,
        },
        { tag: [tags.meta, tags.comment], color: palette.colors.muted },
        { tag: [tags.keyword, tags.processingInstruction], color: palette.colors.purple },
        { tag: [tags.number, tags.bool, tags.null, tags.atom], color: palette.colors.accent },
        {
          tag: [
            tags.typeName,
            tags.className,
            tags.namespace,
            tags.function(tags.variableName),
            tags.function(tags.propertyName),
          ],
          color: palette.colors.blue,
        },
        { tag: [tags.propertyName, tags.attributeName], color: palette.colors.blue },
        { tag: tags.tagName, color: palette.colors.accent },
      ]),
    ),
  ];
}
