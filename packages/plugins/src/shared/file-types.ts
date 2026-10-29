export const isMarkdownFile = (file?: string) =>
  file === undefined || /\.(md|markdown|mdown)$/i.test(file);
