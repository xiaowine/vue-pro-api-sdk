import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
	base: '/vue-dist/',
	root: 'vue',
	plugins: [vue()],
	build: {
		outDir: '../vue-dist',
		// cssCodeSplit: false,
		// rollupOptions: {
		// 	output: {
		// 		entryFileNames: 'bundle.js',
		// 		chunkFileNames: 'bundle.js',
		// 		assetFileNames: (assetInfo) => {
		// 			if (assetInfo.name && assetInfo.name.endsWith('.css')) return 'bundle.css';
		// 			return 'assets/[name].[ext]';
		// 		},
		// 		manualChunks: () => 'bundle'
		// 	}
		// }
	},
});
