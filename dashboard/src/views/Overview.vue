<template>
  <div>
    <div class="eyebrow">MinTask · 数据同步自小程序</div>
    <div class="section-head">
      <h2 class="section-title">团队总览</h2>
      <span class="section-sub">最近同步：{{ store.lastSync || '—' }}</span>
    </div>

    <div class="kpi-grid section">
      <KpiCard v-for="k in store.kpis" :key="k.key" :label="k.label" :value="k.value" :cls="k.cls" />
    </div>

    <div class="section">
      <div class="section-head"><h3 class="section-title">任务分布</h3></div>
      <div class="chart-grid">
        <div class="card"><CategoryPie /></div>
        <div class="card"><StatusBar /></div>
      </div>
    </div>

    <div class="section">
      <div class="card"><WeeklyTrend /></div>
    </div>

    <div class="section">
      <div class="section-head">
        <h3 class="section-title">风险与临期</h3>
        <span class="section-sub">{{ store.riskList.length }} 项需关注</span>
      </div>
      <div class="card" style="padding: 14px 16px"><RiskList @open="open" /></div>
    </div>

    <TaskDetailDrawer v-if="selected" :task="selected" @close="selected = null" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useStore } from '../store/dashboard';
import KpiCard from '../components/KpiCard.vue';
import CategoryPie from '../components/charts/CategoryPie.vue';
import StatusBar from '../components/charts/StatusBar.vue';
import WeeklyTrend from '../components/charts/WeeklyTrend.vue';
import RiskList from '../components/RiskList.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';

const store = useStore();
const selected = ref(null);
function open(t) { selected.value = t; }
</script>
