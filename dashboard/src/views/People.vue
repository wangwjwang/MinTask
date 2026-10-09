<template>
  <div>
    <div class="section-head">
      <h2 class="section-title">人员看板</h2>
      <span class="section-sub">按主办人聚合负载 · 点击查看该人任务</span>
    </div>
    <FilterBar />
    <PeopleBoard @select="openPerson" />

    <!-- 某人任务抽屉 -->
    <div class="drawer-mask" v-if="person" @click.self="person = null">
      <div class="drawer">
        <div class="drawer-head">
          <div class="dh-title">{{ person.name }} 的任务</div>
          <button class="drawer-close" @click="person = null">×</button>
        </div>
        <div class="drawer-meta">
          <span class="badge tone-idle plain">{{ person.dept }}</span>
          <span class="badge tone-idle plain">主办 {{ person.total }}</span>
          <span class="badge tone-idle plain">平均完成度 {{ person.avg }}%</span>
        </div>
        <div style="margin-top: 14px">
          <TaskCard v-for="t in personTasks" :key="t._id" :task="t" @open="openTask" />
          <div v-if="!personTasks.length" style="font-size:13px;color:var(--c-text-faint)">该筛选下无任务</div>
        </div>
      </div>
    </div>

    <TaskDetailDrawer v-if="selected" :task="selected" @close="selected = null" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useStore } from '../store/dashboard';
import FilterBar from '../components/FilterBar.vue';
import PeopleBoard from '../components/PeopleBoard.vue';
import TaskCard from '../components/TaskCard.vue';
import TaskDetailDrawer from '../components/TaskDetailDrawer.vue';

const store = useStore();
const person = ref(null);
const selected = ref(null);
const personTasks = computed(() =>
  person.value ? store.filteredTasks.filter((t) => t.leaderName === person.value.name) : []
);
function openPerson(p) { person.value = p; }
function openTask(t) { selected.value = t; }
</script>
