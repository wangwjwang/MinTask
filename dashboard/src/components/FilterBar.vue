<template>
  <div class="filter-bar">
    <div class="fgroup">
      <label>分类</label>
      <button v-for="c in store.categories" :key="c" class="chip" :class="{ active: store.filters.category === c }" @click="store.setFilter('category', c)">{{ c }}</button>
    </div>
    <div class="fgroup">
      <label>状态</label>
      <button v-for="s in store.statusOptions" :key="s" class="chip" :class="{ active: store.filters.status === s }" @click="store.setFilter('status', s)">{{ s }}</button>
    </div>
    <div class="fgroup">
      <label>阶段</label>
      <button v-for="s in store.stageOptions" :key="s" class="chip" :class="{ active: store.filters.stage === s }" @click="store.setFilter('stage', s)">{{ s }}</button>
    </div>
    <div class="fgroup">
      <label>主办</label>
      <button v-for="l in store.leaders" :key="l" class="chip" :class="{ active: store.filters.leader === l }" @click="store.setFilter('leader', l)">{{ l }}</button>
    </div>
    <input class="search-input" placeholder="搜索任务 / 人员" :value="store.filters.q" @input="store.setFilter('q', $event.target.value)" />
    <button class="chip" @click="store.resetFilters()">重置</button>
  </div>
</template>

<script setup>
import { useStore } from '../store/dashboard';
const store = useStore();
</script>
