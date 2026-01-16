declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<{}, {}, any>;
	export default component;
}

interface ImportMetaEnv {
	readonly BASE_URL: string;
	[key: string]: string | undefined;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
