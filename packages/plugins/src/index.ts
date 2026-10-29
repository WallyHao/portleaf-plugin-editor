import type { Plugin } from '@portleaf/core';
import { manifest as manifest0 } from './markdown/manifest.js';
import { manifest as manifest1 } from './markdown-visual/manifest.js';
import { manifest as manifest2 } from './vim/manifest.js';
import { manifest as manifest3 } from './file-browser/manifest.js';
import { manifest as manifest4 } from './navigation/manifest.js';
import { manifest as manifest5 } from './history/manifest.js';
import { manifest as manifest6 } from './theme-folio/manifest.js';
import { manifest as manifest7 } from './theme-minimal/manifest.js';
import { manifest as outlineManifest } from './outline/manifest.js';
import { manifest as textFilesManifest } from './text-files/manifest.js';
import { manifest as mediaViewerManifest } from './media-viewer/manifest.js';
import { manifest as markdownHtmlManifest } from './markdown-html/manifest.js';

// Metadata is eager; implementations and their dependencies load only when enabled.
export const builtInPlugins: readonly Plugin[] = [
  { ...manifest0, load: async () => (await import('./markdown/index.js')).markdownPlugin },
  {
    ...manifest1,
    load: async () => (await import('./markdown-visual/index.js')).markdownVisualPlugin,
  },
  {
    ...markdownHtmlManifest,
    load: async () => (await import('./markdown-html/index.js')).markdownHtmlPlugin,
  },
  { ...manifest2, load: async () => (await import('./vim/index.js')).vimPlugin },
  { ...manifest3, load: async () => (await import('./file-browser/index.js')).fileBrowserPlugin },
  { ...manifest4, load: async () => (await import('./navigation/index.js')).navigationPlugin },
  { ...manifest5, load: async () => (await import('./history/index.js')).historyPlugin },
  { ...outlineManifest, load: async () => (await import('./outline/index.js')).outlinePlugin },
  {
    ...mediaViewerManifest,
    load: async () => (await import('./media-viewer/index.js')).mediaViewerPlugin,
  },
  {
    ...textFilesManifest,
    load: async () => (await import('./text-files/index.js')).textFilesPlugin,
  },
  { ...manifest6, load: async () => (await import('./theme-folio/index.js')).folioTheme },
  { ...manifest7, load: async () => (await import('./theme-minimal/index.js')).minimalTheme },
];
