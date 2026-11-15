/**
 * Authenty AE - Bom Princípio-RS  |  github.com/authentyAE
 * by: will.i.am                   |  github.com/williampilger
 *
 * 2026.11.15 - Build do pacote (ESM + .d.ts em dist/)
 */
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
});
