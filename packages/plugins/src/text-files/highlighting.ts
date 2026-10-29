import {
  Compartment,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { ViewPlugin } from '@codemirror/view';
import type { Buffer } from '@portleaf/core';
import { detectFileLanguage, fileLanguages } from './languages.js';

export const chooseFileLanguage = StateEffect.define<string>();
const loadedLanguage = StateEffect.define<string>();
export const fileLanguage = StateField.define({
  create: () => ({ choice: 'auto', name: 'Plain text' }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(chooseFileLanguage)) value = { ...value, choice: effect.value };
      if (effect.is(loadedLanguage)) value = { ...value, name: effect.value };
    }
    return value;
  },
});

export function fileHighlighting(
  buffer: Pick<Buffer, 'info'>,
  report: (error: unknown) => void,
  catalog = fileLanguages,
): Extension {
  const language = new Compartment();
  return [
    fileLanguage,
    language.of([]),
    ViewPlugin.define((view) => {
      let destroyed = false,
        revision = 0;
      let previous: LanguageDescription | null | undefined;
      function select() {
        const choice = view.state.field(fileLanguage).choice;
        const selected =
          choice === 'plain'
            ? null
            : choice === 'auto'
              ? detectFileLanguage(
                  buffer.info?.path ?? '',
                  view.state.sliceDoc(0, Math.min(256, view.state.doc.length)).split('\n', 1)[0],
                  catalog,
                )
              : LanguageDescription.matchLanguageName(catalog, choice, false);
        if (selected === previous) return;
        previous = selected;
        const version = ++revision;
        void (selected?.load() ?? Promise.resolve(undefined))
          .then((support) => {
            if (destroyed || version !== revision) return;
            view.dispatch({
              effects: [
                language.reconfigure(support ?? []),
                loadedLanguage.of(selected?.name ?? 'Plain text'),
              ],
              annotations: Transaction.addToHistory.of(false),
            });
          })
          .catch((error) => {
            if (destroyed || version !== revision) return;
            view.dispatch({
              effects: [language.reconfigure([]), loadedLanguage.of('Plain text')],
              annotations: Transaction.addToHistory.of(false),
            });
            previous = undefined;
            report(
              new Error(
                `Cannot load ${selected?.name ?? 'file'} highlighting: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          });
      }
      select();
      return {
        update(update) {
          if (
            update.docChanged ||
            update.transactions.some(
              (transaction) =>
                transaction.reconfigured ||
                transaction.effects.some((effect) => effect.is(chooseFileLanguage)),
            )
          )
            select();
        },
        destroy() {
          destroyed = true;
          revision++;
        },
      };
    }),
  ];
}
