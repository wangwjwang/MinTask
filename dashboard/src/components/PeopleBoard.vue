<template>
  <div class="people-grid">
    <PersonCard v-for="p in store.peopleAgg" :key="p.name" :person="p" @select="$emit('select', $event)" />
    <div v-if="!store.peopleAgg.length" style="color:var(--c-text-faint)">暂无人员数据</div>
  </div>
</template>

<script setup>
import { useStore } from '../store/dashboard';
import PersonCard from './PersonCard.vue';
const store = useStore();
defineEmits(['select']);
</script>
