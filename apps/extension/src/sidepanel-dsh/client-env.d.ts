/**
 * Ambient module declarations for the SidePanel client build (tsconfig.client.json).
 *
 * `*.css` — vite-side stylesheets: the bundler turns the import into a style
 * link/inline, so the runtime value is a side effect only. Needed while no
 * client source imported a stylesheet before Appica (extension-shell injects
 * its CSS through template strings).
 */

declare module '*.css'
