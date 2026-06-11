/**
 * Custom theme: VitePress default + Alfred brand tokens (custom.css), a
 * maturity StatusStrip under the hero actions, and the ReplayTerminal
 * component used on the home page.
 */
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import ReplayTerminal from "./components/ReplayTerminal.vue";
import StatusStrip from "./components/StatusStrip.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-actions-after": () => h(StatusStrip),
    }),
  enhanceApp({ app }) {
    app.component("ReplayTerminal", ReplayTerminal);
  },
} satisfies Theme;
