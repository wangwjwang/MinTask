<template>
  <div class="board">
    <div
      class="board-col"
      v-for="col in store.boardColumns"
      :key="col.stage"
      :class="colCls(col.stage)"
    >
      <div class="board-col-head">
        <span class="col-dot"></span>
        <span class="col-title">{{ col.stage }}</span>
        <span class="col-count">{{ col.count }}</span>
      </div>
      <TaskCard v-for="t in col.tasks" :key="t._id" :task="t" @open="$emit('open', $event)" />
      <div v-if="!col.tasks.length" style="font-size:12px;color:var(--c-text-faint);padding:8px 4px">暂无任务</div>
    </div>
  </div>
</template>

<script setup>
import { useStore } from '../store/dashboard';
import TaskCard from './TaskCard.vue';
const store = useStore();
function colCls(stage) {
  return { 未开始: '', 进行中: 'is-active', 已完成: 'is-done' }[stage] || '';
}
defineEmits(['open']);
</script>
