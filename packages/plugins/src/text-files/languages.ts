import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

// The catalog is metadata only. Each grammar is imported by its native lazy loader.
export const fileLanguages: readonly LanguageDescription[] = [
  ...languages,
  LanguageDescription.of({
    name: 'Nix',
    extensions: ['nix'],
    load: () => import('@replit/codemirror-lang-nix').then((module) => module.nix()),
  }),
];

export function detectFileLanguage(file: string, firstLine = '', catalog = fileLanguages) {
  const name = file.split(/[\\/]/).at(-1)!;
  const known =
    LanguageDescription.matchFilename(catalog, name) ??
    LanguageDescription.matchFilename(
      catalog,
      name.replace(/\.[^.]+$/, (extension) => extension.toLowerCase()),
    );
  if (known) return known;
  let alias: string | undefined;
  if (
    /^(?:\.(?:bashrc|bash_profile|profile|zshrc|zprofile|zshenv|env)(?:\..*)?|.*\.zsh)$/i.test(name)
  )
    alias = 'Shell';
  else if (/^(?:Dockerfile|Containerfile)(?:\..*)?$/i.test(name)) alias = 'Dockerfile';
  else if (name === 'flake.lock') alias = 'JSON';
  else if (/^(?:Cargo|Pipfile|poetry|uv)\.lock$/.test(name)) alias = 'TOML';
  if (alias) return LanguageDescription.matchLanguageName(catalog, alias, false);
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/);
  let interpreter = words.shift()?.split('/').at(-1);
  if (interpreter === 'env')
    interpreter = words
      .find((word) => !word.startsWith('-') && !word.includes('='))
      ?.split('/')
      .at(-1);
  const base = interpreter?.replace(/[\d.]+$/, '');
  const aliases: Record<string, string> = {
    nodejs: 'JavaScript',
    dash: 'Shell',
    ksh: 'Shell',
    pypy: 'Python',
    'ts-node': 'TypeScript',
    deno: 'TypeScript',
  };
  return base ? LanguageDescription.matchLanguageName(catalog, aliases[base] ?? base, false) : null;
}
