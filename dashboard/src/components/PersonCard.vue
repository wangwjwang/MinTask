<template>
  <div class="person-card" @click="$emit('select', person)">
    <div class="pc-head">
      <span class="avatar" :style="{ background: avatarColor(person.name) }">{{ person.name.slice(0, 1) }}</span>
      <div>
        <div class="pc-name">{{ person.name }}</div>
        <div class="pc-dept">{{ person.dept }}</div>
      </div>
    </div>
    <div class="pc-stats">
      <div class="pc-stat"><div class="v">{{ person.total }}</div><div class="l">主办</div></div>
      <div class="pc-stat"><div class="v">{{ person.doing }}</div><div class="l">进行中</div></div>
      <div class="pc-stat"><div class="v">{{ person.done }}</div><div class="l">已完成</div></div>
      <div class="pc-stat"><div class="v" :style="{ color: (person.blocked + person.risk) ? 'var(--c-danger)' : '' }">{{ person.blocked + person.risk }}</div><div class="l">风险</div></div>
    </div>
    <div class="mini-bar"><i :style="{ width: person.avg + '%' }"></i></div>
    <div style="font-size:12px;color:var(--c-text-faint);margin-top:6px">平均完成度 {{ person.avg }}%</div>
  </div>
</template>

<script setup>
import { avatarColor } from '../utils';
defineProps({ person: { type: Object, required: true } });
defineEmits(['select']);
</script>
