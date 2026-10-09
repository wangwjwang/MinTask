<template>
  <div>
    <div class="section-head">
      <h2 class="section-title">任务看板</h2>
      <span class="section-sub">按阶段分列 · 点击卡片查看进展时间线</span>
    </div>
    <FilterBar />
    <TaskBoard @open="open" />
    <TaskDetailDrawer v-if="selected" :task="selected" @close="selected = null" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useStore } from '../store/dashboard';
import FilterBar from '../components/FilterBar.vue';
import TaskBoard from '../components/TaskBoard.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';

const store = useStore();
const selected = ref(null);
function open(t) { selected.value = t; }
</script>
