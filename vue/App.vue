<script setup lang="ts">
import { onMounted } from 'vue';
import router from './router';

onMounted(() => {
  var page = eda.sys_Storage.getExtensionUserConfig('page');
  if (typeof page === 'string' && page.length > 0) {
    router.push({ name: page });
  }
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
