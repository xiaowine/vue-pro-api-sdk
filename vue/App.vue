<script setup lang="ts">
import { onMounted } from 'vue';
import router from './router';
import { isEDA } from './utils/utils';
import * as extensionConfig from '../extension.json';

onMounted(() => {
  if (isEDA) {
    var page = eda.sys_Storage.getExtensionAllUserConfigs()[extensionConfig.name];
    if (typeof page === 'string' && page.length > 0) {
      router.push({ name: page });
    }
  }
  console.log('is EDA environment:', isEDA);
});
</script>

<template>
  <router-view />
</template>

<style lang="scss">
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  user-select: none;
}
</style>
