<script setup lang="ts">
useHead({
  titleTemplate: (title) =>
    title ? `${title} · Technical Records Browser` : 'Technical Records Browser',
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
