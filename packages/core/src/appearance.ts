export type Theme = { dark: boolean; colors: Record<string, string> };

export function applyAppearance(
  root: HTMLElement,
  font: { fontFamily: string; fontSize: number },
  palette: Theme,
) {
  for (const [name, value] of Object.entries(palette.colors))
    if (name in minimalPalette.colors) root.style.setProperty(`--${name}`, value);
  root.style.colorScheme = palette.dark ? 'dark' : 'light';
  root.style.setProperty('--font-family', `${JSON.stringify(font.fontFamily)}, monospace`);
  root.style.setProperty('--font-size', `${font.fontSize}pt`);
}

export const minimalPalette: Theme = {
  dark: true,
  colors: {
    background: '#171a1b',
    foreground: '#d7d9d5',
    surface: '#202526',
    muted: '#83908d',
    accent: '#b6caa5',
    selection: '#354344',
    border: '#465250',
    error: '#e89a91',
    blue: '#9fc1ce',
    purple: '#c2acd1',
    green: '#b6caa5',
  },
};
