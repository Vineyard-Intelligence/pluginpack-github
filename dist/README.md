# dist/

The runnable bundle (`pack.mjs`), built from `src/main.ts` + the three plugin modules
by `build.mjs` (esbuild). The SDK (`src/sdk.ts`) is inlined on purpose — the module is
fetched by URL and runs in a worker with no import map.

Regenerate after editing source:

```bash
npm run build
```
