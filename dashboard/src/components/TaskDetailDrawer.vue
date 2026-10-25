<template>
  <div class="drawer-mask" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-head">
        <div class="dh-title">{{ task.name }}</div>
        <button class="drawer-close" @click="$emit('close')">×</button>
      </div>
      <div class="drawer-meta">
        <span class="badge" :class="'tone-' + statusTone(statusBucket(task))">{{ statusBucket(task) }}</span>
        <span class="badge tone-idle plain">{{ task.category }}</span>
        <span class="badge tone-idle plain">{{ task.stage }}</span>
        <span class="badge" :class="'tone-' + priorityTone(task.priority)">{{ task.priority }}</span>
        <span class="badge tone-idle plain">进度 {{ task.progress }}%</span>
      </div>
      <div style="font-size:13px;color:var(--c-text-muted);line-height:1.9">
        主办：<b style="color:var(--c-text)">{{ task.leaderName }}</b><br />
        协办：{{ task.collaborator || '无' }}<br />
        截止：{{ task.dueDate }}（<span :class="di.tone === 'danger' ? 'due-flag danger' : (di.tone === 'warn' ? 'due-flag warn' : '')">{{ di.text }}</span>）<br />
        来源：{{ task.source }} · 性质：{{ task.taskType }}<span v-if="task.recurFreq && task.recurFreq !== '不适用'"> · {{ task.recurFreq }}</span><br />
        卡壳：{{ task.hasOpenBlocker ? ('未解决 ' + (task.openBlockerCount || 1) + ' 项') : '无' }}
      </div>

      <h4 style="margin:20px 0 12px">进展时间线</h4>
      <div class="timeline">
        <div class="tl-item" v-for="(p, i) in task.timeline" :key="i" :class="{ blocked: p.hasBlocker }">
          <div class="tl-text">{{ p.text }}</div>
          <div class="tl-time">{{ fmtDateTime(p.time) }} · 进度 {{ p.progress }}%</div>
          <div class="tl-support" v-if="p.support">需要支持：{{ p.support }}</div>
        </div>
        <div v-if="!task.timeline || !task.timeline.length" style="font-size:13px;color:var(--c-text-faint)">暂无进展记录</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { statusTone, priorityTone, dueInfo, fmtDateTime, statusBucket } from '../utils';
const props = defineProps({ task: { type: Object, required: true } });
const di = computed(() => dueInfo(props.task.dueDate, props.task.stage));
defineEmits(['close']);
</script>
