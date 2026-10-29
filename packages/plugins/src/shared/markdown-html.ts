import { Facet } from '@codemirror/state';

export type HtmlRenderer = (
  source: string,
  element: HTMLElement,
  resource: (target: string) => string | undefined,
  follow: (target: string) => void,
  measure: () => void,
) => void;

export const markdownHtml = Facet.define<HtmlRenderer, HtmlRenderer | undefined>({
  combine: (values) => values[0],
});
