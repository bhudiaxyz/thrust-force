/**
 * Vite config — build settings for GitHub Pages hosting.
 *
 * Purpose
 *   Builds the static site in dist/ that the Pages workflow deploys.
 *
 * Operations
 *   - base '/thrust-force/': asset URLs match https://<user>.github.io/thrust-force/.
 *   - target es2020; three.js is split into its own chunk (manualChunks) so browsers keep it
 *     cached across game updates; the chunk warning limit is raised for it.
 *
 * Usage
 *   npm run dev / build / preview. Rename the repository → change base to match.
 *
 * See also: .github/workflows/deploy-pages.yml; DESIGN.md "14. Build and deployment".
 */
import { defineConfig } from 'vite';

export default defineConfig({
    base: '/thrust-force/',
    build: {
        target: 'es2020',
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
            output: {
                manualChunks: (id) => (id.includes('three') ? 'three' : undefined),
            },
        },
    },
});
