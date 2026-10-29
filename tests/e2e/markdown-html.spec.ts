import { readFile } from 'node:fs/promises';
import { test, expect } from './support/desktop.js';

const readme = await readFile('README.md', 'utf8');
const light = await readFile('assets/branding/header-light.svg');
const dark = await readFile('assets/branding/header-dark.svg');
const screenshot = await readFile('assets/screenshot.png');

test.use({
  desktopOptions: {
    content: readme,
    files: {
      'assets/branding/header-light.svg': light,
      'assets/branding/header-dark.svg': dark,
      'assets/screenshot.png': screenshot,
    },
  },
});

test('README HTML fits half and full widths without preserving source indentation', async ({
  app,
}) => {
  const page = app.page;
  await page.keyboard.type('27j');
  const html = page.locator('.md-html').first();
  const image = html.locator('img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(760);
  for (const width of [700, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await html.evaluate((element) => {
      const heading = element.querySelector('h1')!;
      const image = element.querySelector('img')!;
      const paragraph = element.querySelector('p')!;
      const outer = element.getBoundingClientRect();
      const header = heading.getBoundingClientRect();
      const picture = image.getBoundingClientRect();
      const text = paragraph.getBoundingClientRect();
      return {
        whitespace: getComputedStyle(element).whiteSpace,
        headingFont: getComputedStyle(heading).fontSize,
        font: getComputedStyle(element).fontSize,
        topGap: header.top - outer.top,
        imageWidth: picture.width,
        availableWidth: outer.width,
        paragraphGap: text.top - picture.bottom,
        imageCenterOffset: Math.abs((picture.left + picture.right - outer.left - outer.right) / 2),
        paragraphAlign: getComputedStyle(paragraph).textAlign,
        leftMargin: outer.left - element.closest('.cm-scroller')!.getBoundingClientRect().left,
        rightMargin:
          element.closest('.cm-scroller')!.getBoundingClientRect().left +
          element.closest('.cm-scroller')!.clientWidth -
          outer.right,
      };
    });
    expect(layout.whitespace).toBe('normal');
    expect(layout.headingFont).toBe(layout.font);
    expect(layout.topGap).toBeLessThan(4);
    expect(layout.imageWidth).toBeLessThanOrEqual(layout.availableWidth);
    expect(layout.paragraphGap).toBeLessThan(40);
    expect(layout.imageCenterOffset).toBeLessThan(2);
    expect(layout.paragraphAlign).toBe('center');
    expect(Math.abs(layout.leftMargin - layout.rightMargin)).toBeLessThan(2);
    const imageLayout = await page.locator('.md-image img').evaluate((image: HTMLImageElement) => {
      const content = image.closest('.cm-content')!;
      const style = getComputedStyle(content);
      const available =
        content.getBoundingClientRect().width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const rect = image.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        available,
        ratio: image.naturalWidth / image.naturalHeight,
      };
    });
    expect(imageLayout.width).toBeCloseTo(imageLayout.available, 0);
    expect(imageLayout.width / imageLayout.height).toBeCloseTo(imageLayout.ratio, 2);
  }
});
