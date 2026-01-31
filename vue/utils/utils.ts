import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { RouteLocationNormalizedLoaded } from 'vue-router';

export const isEDA = typeof window !== 'undefined' && (window as any).eda !== undefined;
/**
 * 从给定路由对象安全获取路由 name（字符串）。
 */
function getRouteName(route?: RouteLocationNormalizedLoaded): string {
	if (!route) return '';
	return route.name ? String(route.name) : '';
}

/**
 * 组合式钩子：在 `setup()` 中调用，返回当前路由的 name（响应式 `ComputedRef<string>`）。
 *
 * 用法：
 * const routeName = useRouteName();
 * console.log(routeName.value);
 */
export function useRouteName(): ComputedRef<string> {
	const route = useRoute();
	return computed(() => getRouteName(route));
}
