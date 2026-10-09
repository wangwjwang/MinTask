<template>
  <div class="risk-list">
    <div class="risk-item" v-for="r in store.riskList" :key="r.task._id" @click="$emit('open', r.task)">
      <span class="ri-dot" :style="{ background: r.tone === 'danger' ? 'var(--c-danger)' : 'var(--c-warn)' }"></span>
      <span class="ri-name">{{ r.task.name }}</span>
      <span class="ri-reason">{{ r.reason }}</span>
    </div>
    <div v-if="!store.riskList.length" style="font-size:13px;color:var(--c-ok);padding:6px 2px">暂无风险项，状态良好 🎉</div>
  </div>
</template>

<script setup>
import { useStore } from '../store/dashboard';
const store = useStore();
defineEmits(['open']);
</script>
