/**
 * Site theme: the VitePress default theme plus the landing-page brand layer
 * (`custom.css`), scoped to the home route so documentation pages keep the
 * stock look in both color modes.
 */
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './custom.css'

export default {
  extends: DefaultTheme,
} satisfies Theme
