import { defineConfig } from "@ghost/core";

export default defineConfig({
  designSystems: [
    {
      name: "bloose",
      registry: "https://block.github.io/ghost/r/registry.json",
      componentDir: "src/shared/ui",
      styleEntry: "src/shared/styles/globals.css",
    },
  ],
});
