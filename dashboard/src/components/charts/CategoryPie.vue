<template>
  <div class="chart-box" ref="el"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import { useStore } from '../../store/dashboard';
import { readTokens, CATEGORY_PALETTE } from './charts-theme';
import { fixTouchStuckEmphasis } from './touchFix';

const store = useStore();
const el = ref(null);
let chart = null;

function resize() { if (chart) chart.resize(); }

function render() {
  if (!chart) return;
  const t = readTokens();
  const counts = {};
  store.filteredTasks.forEach((x) => { counts[x.category] = (counts[x.category] || 0) + 1; });
  const data = Object.entries(counts).map(([k, v]) => ({ name: k, value: v }));
  chart.setOption({
    color: CATEGORY_PALETTE,
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: {
      type: 'scroll', orient: 'horizontal', bottom: 0, left: 'center',
      textStyle: { color: t.muted, fontSize: 11 },
    },
    series: [{
      type: 'pie', radius: ['42%', '70%'], center: ['50%', '44%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 6 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 600, color: t.text, formatter: '{b}\n{c}' } },
      data,
    }],
  }, true);
}

onMounted(() => { chart = echarts.init(el.value); fixTouchStuckEmphasis(chart); render(); window.addEventListener('resize', resize); });
onBeforeUnmount(() => { window.removeEventListener('resize', resize); if (chart) chart.dispose(); });
watch(() => store.theme, render);
watch(() => store.filteredTasks, render, { deep: false });
</script>
