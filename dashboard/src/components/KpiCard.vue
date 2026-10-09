<template>
  <div class="kpi-card" :class="cls">
    <span class="kpi-accent"></span>
    <div class="kpi-label">{{ label }}</div>
    <div class="kpi-value">{{ value }}</div>
    <div class="kpi-foot" v-if="foot">{{ foot }}</div>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], required: true },
  foot: { type: String, default: '' },
  cls: { type: String, default: '' },
});
</script>
