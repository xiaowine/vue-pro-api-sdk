import { createMemoryHistory, createRouter } from 'vue-router';

import First from './pages/First.vue';
import Second from './pages/Second.vue';

const router = createRouter({
	history: createMemoryHistory('/vue-dist'),
	routes: [
		{
			path: '/:pathMatch(.*)*',
			name: 'not-found',
			redirect: { name: 'First' },
		},
		{
			path: '/',
			name: 'First',
			component: First,
		},
		{
			path: '/Second',
			name: 'Second',
			component: Second,
		},
	],
});

export default router;
