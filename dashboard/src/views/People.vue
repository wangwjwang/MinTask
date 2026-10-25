<template>
  <div>
    <div class="section-head">
      <h2 class="section-title">人员看板</h2>
      <span class="section-sub">按成员聚合负载（主办 + 协办）· 点击查看该人任务</span>
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
          <span class="badge tone-idle plain">主办 {{ person.led }}</span>
          <span class="badge tone-idle plain">协办 {{ person.joined }}</span>
          <span class="badge tone-idle plain">在办 {{ person.open }}</span>
          <span class="badge tone-idle plain">已完成 {{ person.done }}</span>
          <span class="badge tone-idle plain">平均完成度 {{ person.avg }}%</span>
        </div>
        <div style="margin-top: 14px">
          <div style="font-size:12px;font-weight:600;color:var(--c-text-muted);margin:14px 0 8px">主办 {{ ledTasks.length }}</div>
          <TaskCard v-for="t in ledTasks" :key="t._id" :task="t" @open="openTask" />
          <div v-if="!ledTasks.length" style="font-size:13px;color:var(--c-text-faint)">无主办任务</div>
          <div style="font-size:12px;font-weight:600;color:var(--c-text-muted);margin:14px 0 8px">协办 {{ joinedTasks.length }}</div>
          <TaskCard v-for="t in joinedTasks" :key="t._id" :task="t" @open="openTask" />
          <div v-if="!joinedTasks.length" style="font-size:13px;color:var(--c-text-faint)">无协办任务</div>
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
import { splitCollaborators } from '../utils';

const store = useStore();
const person = ref(null);
const selected = ref(null);
// 某人的任务 = 主办的 + 协办的（协办人是分号分隔的姓名串）。
// ★ 2026-10-19 修：原来只按 leaderName 查，协办任务整段缺失 ——
//   用户实测"何梦欣只有 3 条已完成，实际 3 主办 + 7 协办"。
// ★ 无主办的任务在聚合里归入"未分配"（见 store.peopleAgg），这里同口径兜底，
//   否则点"未分配"卡片会看到空列表。
const ownerOf = (t) => t.leaderName || '未分配';
const isInvolved = (t, name) => ownerOf(t) === name || splitCollaborators(t.collaborator).includes(name);
const personTasks = computed(() =>
  person.value ? store.filteredTasks.filter((t) => isInvolved(t, person.value.name)) : []
);
const ledTasks = computed(() => personTasks.value.filter((t) => ownerOf(t) === person.value.name));
const joinedTasks = computed(() => personTasks.value.filter((t) => ownerOf(t) !== person.value.name));
function openPerson(p) { person.value = p; }
function openTask(t) { selected.value = t; }
</script>
