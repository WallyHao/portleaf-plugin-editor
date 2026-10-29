import { manifest } from './manifest.js';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching } from '@codemirror/language';
import type { Plugin } from '@portleaf/core';
import { isMarkdownFile } from '../shared/file-types.js';

export const markdownPlugin: Plugin = {
  ...manifest,
  extension: ({ buffer }) =>
    isMarkdownFile(buffer.info?.path)
      ? [markdown({ base: markdownLanguage }), bracketMatching()]
      : [],
};
