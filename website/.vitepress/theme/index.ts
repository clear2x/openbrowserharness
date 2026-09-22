/**
 * Site theme: the VitePress default theme plus the landing-page brand layer
 * (`custom.css`) and the hero collage layout (`LandingLayout.vue`), scoped to
 * the home route so documentation pages keep the stock look in both color
 * modes.
 */
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import LandingLayout from './LandingLayout.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: LandingLayout,
} satisfies Theme
