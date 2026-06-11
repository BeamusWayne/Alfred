<script setup lang="ts">
// Maturity signals under the hero actions. Nothing here is hand-maintained:
// version and dependency count come from package.json and the test count is
// MEASURED during the docs build (see `vite.define` in config.ts) — the
// homepage never claims a number the build didn't just verify. A failed
// measurement drops the item rather than showing a stale one.
const ITEMS = [
  `v${__PKG_VERSION__}`,
  __TEST_COUNT__ === null ? null : `${__TEST_COUNT__} tests`,
  `${__RUNTIME_DEPS__} runtime deps`,
  "MIT",
].filter((item): item is string => item !== null);
</script>

<template>
  <p class="status-strip">
    <template v-for="(item, i) in ITEMS" :key="item">
      <span v-if="i > 0" class="sep" aria-hidden="true">·</span>
      <span class="item">{{ item }}</span>
    </template>
  </p>
</template>

<style scoped>
.status-strip {
  margin: 18px 0 0;
  font-size: 13px;
  font-family: var(--vp-font-family-mono);
  line-height: 1.8;
  color: var(--vp-c-text-2);
}
.sep {
  margin: 0 8px;
  color: var(--vp-c-text-3);
}
@media (max-width: 639px) {
  .status-strip {
    font-size: 12px;
  }
}
</style>
