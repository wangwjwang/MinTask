import { createRouter, createWebHashHistory } from 'vue-router';
import Overview from '../views/Overview.vue';
import Tasks from '../views/Tasks.vue';
import People from '../views/People.vue';

const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: Overview, meta: { title: '总览' } },
  { path: '/tasks', name: 'tasks', component: Tasks, meta: { title: '任务看板' } },
  { path: '/people', name: 'people', component: People, meta: { title: '人员看板' } },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
