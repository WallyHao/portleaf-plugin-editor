import { bracketMatching } from '@codemirror/language';
import { Transaction } from '@codemirror/state';
import type { Plugin } from '@portleaf/core';
import { isMarkdownFile } from '../shared/file-types.js';
import { manifest } from './manifest.js';
import { chooseFileLanguage, fileHighlighting, fileLanguage } from './highlighting.js';
import { fileLanguages } from './languages.js';
import './style.css';

export const textFilesPlugin: Plugin = {
  ...manifest,
  activate(context) {
    context.registerCommand('text.open', () => {
      context.picker.prompt('Open text file', '', async (file) => {
        await context.buffers.open(file);
      });
    });
    context.registerCommand('text.create', () => {
      context.picker.prompt('New text file (exact name)', '', async (file) => {
        await context.buffers.open(file, true);
      });
    });
    context.registerCommand('text.language', () => {
      const buffer = context.buffers.active();
      const current = buffer?.view?.state.field(fileLanguage, false);
      if (!buffer?.view || !current) throw new Error('Select a text file to choose its language.');
      const choices = [
        { label: 'Auto-detect', value: 'auto' },
        { label: 'Plain text', value: 'plain' },
        ...[...fileLanguages]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((language) => ({ label: language.name, value: language.name })),
      ];
      context.picker.show(
        'Select file language',
        choices.map((choice) => ({
          label: choice.label,
          run() {
            if (
              context.signal.aborted ||
              context.buffers.active() !== buffer ||
              !buffer.view?.state.field(fileLanguage, false)
            )
              return;
            buffer.view.dispatch({
              effects: chooseFileLanguage.of(choice.value),
              annotations: Transaction.addToHistory.of(false),
            });
            buffer.view.focus();
          },
        })),
        undefined,
        choices.findIndex((choice) => choice.value === current.choice),
      );
    });
    const button = document.createElement('button');
    button.className = 'file-language';
    button.type = 'button';
    button.setAttribute('aria-label', 'File language');
    button.title = 'Select file language (Space u l)';
    button.onclick = () => {
      void context.commands.execute('text.language').catch(context.report);
    };
    const update = () => {
      const value = context.buffers.active()?.view?.state.field(fileLanguage, false);
      button.hidden = !value;
      button.textContent = value?.name ?? '';
    };
    context.status.append(button);
    context.onDispose(() => button.remove());
    context.onDispose(context.buffers.subscribe(update));
    update();
  },
  extension: ({ buffer, app }) =>
    isMarkdownFile(buffer.info?.path)
      ? []
      : [bracketMatching(), fileHighlighting(buffer, app.report)],
};
