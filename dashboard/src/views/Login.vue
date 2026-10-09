<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>TeamPulse 团队看板</h1>
      <p>请输入团队共享访问口令以进入（口令由管理员在群里统一下发）。</p>
      <div v-if="error" class="login-error">{{ error }}</div>
      <input
        v-model="code"
        type="password"
        placeholder="访问口令"
        @keyup.enter="submit"
        autofocus
      />
      <button class="btn-primary" @click="submit">进入看板</button>
      <p style="margin-top:16px;font-size:12px;color:var(--c-text-faint)">
        数据与小程序的任务看板同源（同一云数据库），只读展示，不可修改。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useStore } from '../store/dashboard';
const store = useStore();
const code = ref('');
const error = ref('');
async function submit() {
  if (!code.value.trim()) { error.value = '请输入口令'; return; }
  error.value = '';
  try {
    await store.login(code.value.trim());
  } catch (e) {
    error.value = e.message || '口令校验失败';
    store.logout();
  }
}
</script>
