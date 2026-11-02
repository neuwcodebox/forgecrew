import { defineConfig } from 'tsup';

export default defineConfig({
  platform:'node',target:'node24',format:['esm'],clean:true,splitting:false,
  banner:{js:"import { createRequire as __forgecrewCreateRequire } from 'node:module'; const require = __forgecrewCreateRequire(import.meta.url);"},
});
