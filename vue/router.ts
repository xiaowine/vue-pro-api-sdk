import { createRouter, createWebHistory } from 'vue-router';

import First from './pages/First.vue';
import Second from './pages/Second.vue';

const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	routes: [
		{
			path: '/:pathMatch(.*)*',
			name: 'not-found',
			redirect: { name: 'First' },
		},
		{
			path: '/First',
			name: 'First',
			component: First,
		},
		{
			path: '/',
			name: 'Second',
			component: Second,
		},
	],
});

export default router;
