<template>
  <div class="chart-box" ref="el"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import { useStore } from '../../store/dashboard';
import { readTokens } from './charts-theme';
import { fixTouchStuckEmphasis } from './touchFix';
import { statusBucket } from '../../utils';

const store = useStore();
const el = ref(null);
let chart = null;
// 四态互斥分布（卡壳 > 已完成 > 逾期 > 正常），与 KPI、状态筛选同一口径
const ORDER = ['正常', '逾期', '卡壳', '已完成'];

function resize() { if (chart) chart.resize(); }

function render() {
  if (!chart) return;
  const t = readTokens();
  const counts = { 正常: 0, 逾期: 0, 卡壳: 0, 已完成: 0 };
  store.filteredTasks.forEach((x) => { const s = statusBucket(x); counts[s] = (counts[s] || 0) + 1; });
  const colorOf = { 正常: t.ok, 逾期: t.danger, 卡壳: t.danger, 已完成: t.done };
  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category', data: ORDER,
      axisLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.muted, fontSize: 12 },
    },
    yAxis: {
      type: 'value', splitLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.faint, fontSize: 11 },
    },
    series: [{
      type: 'bar', barWidth: '46%',
      data: ORDER.map((k) => ({ value: counts[k], itemStyle: { color: colorOf[k], borderRadius: [6, 6, 0, 0] } })),
      label: { show: true, position: 'top', color: t.text, fontSize: 12, fontWeight: 600 },
    }],
  }, true);
}

onMounted(() => { chart = echarts.init(el.value); fixTouchStuckEmphasis(chart); render(); window.addEventListener('resize', resize); });
onBeforeUnmount(() => { window.removeEventListener('resize', resize); if (chart) chart.dispose(); });
watch(() => store.theme, render);
watch(() => store.filteredTasks, render, { deep: false });
</script>
