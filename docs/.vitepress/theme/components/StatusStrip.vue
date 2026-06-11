<script setup lang="ts">
// Maturity signals under the hero actions. Numbers are maintained alongside
// the README status line — update both when the suite grows.
const ITEMS = [
  "v0.2.2",
  "797 tests",
  "tsc --noEmit clean",
  "3 runtime deps",
  "weekly live provider smoke in CI",
  "MIT",
];
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
