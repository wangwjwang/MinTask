<template>
  <div class="task-card" :class="{ blocked: task.hasOpenBlocker }" @click="$emit('open', task)">
    <div class="tc-top">
      <div class="tc-name">{{ task.name }}</div>
      <span class="badge" :class="'tone-' + statusTone(task.status)">{{ task.status }}</span>
    </div>
    <div class="tc-meta">
      <span class="badge tone-idle plain">{{ task.category }}</span>
      <span class="badge" :class="'tone-' + priorityTone(task.priority)">{{ task.priority }}</span>
      <span class="badge tone-idle plain">{{ task.stage }}</span>
    </div>
    <div class="tc-progress"><i :style="{ width: task.progress + '%' }"></i></div>
    <div class="tc-row">
      <span>主办 {{ task.leaderName }}</span>
      <span class="due-flag" :class="di.tone">{{ di.text }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { statusTone, priorityTone, dueInfo } from '../utils';
const props = defineProps({ task: { type: Object, required: true } });
const di = computed(() => dueInfo(props.task.dueDate, props.task.stage));
defineEmits(['open']);
</script>
