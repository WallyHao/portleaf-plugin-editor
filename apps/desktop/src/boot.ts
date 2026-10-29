import '@portleaf/core/ui.css';
import './style.css';
import { applyAppearance, minimalPalette } from '@portleaf/core/appearance';
import { builtInPlugins } from '@portleaf/plugins';
import { bootstrapReady } from './bootstrap.js';
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML =
  '<header class="topline"><span class="workspace-name"></span><span class="muted">portleaf</span></header><main class="workspace"></main><footer class="statusline"><span class="mode">EDIT</span><span class="filename">No file</span><span class="plugin-status"></span><span class="position"></span></footer><div class="message" role="status" aria-live="polite" hidden></div>';

void bootstrapReady
  .then(({ settings, root }) => {
    const theme = builtInPlugins.find((plugin) => plugin.theme?.name === settings.theme)?.theme;
    applyAppearance(app, settings, theme?.palette(settings) ?? minimalPalette);
    app.querySelector<HTMLElement>('.workspace-name')!.textContent = root;
  })
  .catch(() => {});

void import('./renderer.js').catch((error) => {
  const message = app.querySelector<HTMLElement>('.message')!;
  message.textContent = error instanceof Error ? error.message : String(error);
  message.hidden = false;
});
