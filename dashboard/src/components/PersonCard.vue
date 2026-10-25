<template>
  <div class="person-card" @click="$emit('select', person)">
    <div class="pc-head">
      <span class="avatar" :style="{ background: avatarColor(person.name) }">{{ person.name.slice(0, 1) }}</span>
      <div>
        <div class="pc-name">{{ person.name }}</div>
        <div class="pc-dept">{{ person.dept }}</div>
      </div>
    </div>
    <!-- 负载四项与小程序 Tab4 人员卡片同口径：主办/协办/在办/已完成 -->
    <div class="pc-stats">
      <div class="pc-stat"><div class="v">{{ person.led }}</div><div class="l">主办</div></div>
      <div class="pc-stat"><div class="v">{{ person.joined }}</div><div class="l">协办</div></div>
      <div class="pc-stat"><div class="v">{{ person.open }}</div><div class="l">在办</div></div>
      <div class="pc-stat"><div class="v">{{ person.done }}</div><div class="l">已完成</div></div>
    </div>
    <div v-if="person.blocked || person.overdue" class="pc-risk">需关注：{{ riskText(person) }}</div>
    <div class="mini-bar"><i :style="{ width: person.avg + '%' }"></i></div>
    <div style="font-size:12px;color:var(--c-text-faint);margin-top:6px">平均完成度 {{ person.avg }}%</div>
  </div>
</template>

<script setup>
import { avatarColor } from '../utils';
defineProps({ person: { type: Object, required: true } });
defineEmits(['select']);
// 风险行：卡壳/逾期都算"需关注"（与状态四态口径一致），两项都为 0 时整行不渲染
function riskText(p) {
  return [p.blocked ? `卡壳 ${p.blocked}` : '', p.overdue ? `逾期 ${p.overdue}` : ''].filter(Boolean).join(' · ');
}
</script>
