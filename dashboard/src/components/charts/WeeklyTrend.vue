<template>
  <div class="chart-box tall" ref="el"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as echarts from 'echarts';
import { useStore } from '../../store/dashboard';
import { readTokens } from './charts-theme';

const store = useStore();
const el = ref(null);
let chart = null;

function resize() { if (chart) chart.resize(); }

// 演示用：以当前整体完成率为基线，合成近 8 周的完成率走势（真实部署可改为历史快照）。
function synthSeries() {
  const base = store.kpis.find((k) => k.key === 'rate');
  const baseVal = base ? parseInt(base.value, 10) || 0 : 0;
  const out = [];
  let v = Math.max(5, baseVal - 22);
  for (let i = 0; i < 8; i += 1) {
    v = Math.min(100, Math.max(5, v + (baseVal - v) * 0.18 + (i % 2 ? 3 : -1)));
    out.push(Math.round(v));
  }
  out[7] = baseVal;
  return out;
}

function render() {
  if (!chart) return;
  const t = readTokens();
  const data = synthSeries();
  const labels = data.map((_, i) => `第${i + 1}周`);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category', data: labels, boundaryGap: false,
      axisLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    yAxis: {
      type: 'value', max: 100, splitLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.faint, fontSize: 11, formatter: '{value}%' },
    },
    series: [{
      type: 'line', smooth: true, data,
      symbol: 'circle', symbolSize: 7,
      lineStyle: { color: t.accent, width: 3 },
      itemStyle: { color: t.accent },
      areaStyle: { color: t.accent, opacity: 0.12 },
      label: { show: true, color: t.text, fontSize: 11, formatter: '{c}%' },
    }],
  }, true);
}

onMounted(() => { chart = echarts.init(el.value); render(); window.addEventListener('resize', resize); });
onBeforeUnmount(() => { window.removeEventListener('resize', resize); if (chart) chart.dispose(); });
watch(() => store.theme, render);
watch(() => store.filteredTasks, render, { deep: false });
</script>
