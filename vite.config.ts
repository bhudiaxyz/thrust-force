import { defineConfig } from "vite";

export default defineConfig({
    base: "/thrust-force/",
    build: {
        target: "es2020",
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
            output: {
                manualChunks: (id) => (id.includes("three") ? "three" : undefined),
            },
        },
    },
});
