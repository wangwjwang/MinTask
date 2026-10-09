<template>
  <Login v-if="!store.isAuthed" />
  <div v-else class="app-shell">
    <header class="topbar">
      <div class="brandmark"><span class="logo">T</span><span>TeamPulse 团队看板</span></div>
      <nav class="nav-links">
        <router-link class="nav-link" to="/overview">总览</router-link>
        <router-link class="nav-link" to="/tasks">任务看板</router-link>
        <router-link class="nav-link" to="/people">人员看板</router-link>
      </nav>
      <div class="topbar-spacer"></div>
      <button class="btn-refresh" @click="store.refresh()">↻ 刷新</button>
      <button class="btn-refresh" @click="store.logout()">退出</button>
    </header>
    <main class="main">
      <router-view v-if="!store.loading && store.data" />
      <div v-else-if="store.loading" class="loading">数据加载中…</div>
      <div v-else-if="store.error" class="loading" style="color:var(--c-danger)">{{ store.error }}</div>
    </main>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { useStore } from './store/dashboard';
import Login from './views/Login.vue';

const store = useStore();
onMounted(() => {
  if (store.isAuthed) store.refresh();
});
</script>
