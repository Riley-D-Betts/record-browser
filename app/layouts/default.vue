<script setup lang="ts">
const { user, clear } = useUserSession()
const route = useRoute()

const nav = [
  { to: '/', label: 'Overview', icon: 'i-lucide-layout-dashboard' },
  { to: '/browse', label: 'Browse', icon: 'i-lucide-table-2' },
  { to: '/erd', label: 'ERD', icon: 'i-lucide-workflow' },
  { to: '/lineage', label: 'Lineage', icon: 'i-lucide-git-branch' },
  { to: '/reports', label: 'Reports', icon: 'i-lucide-shield-alert' },
  { to: '/transfer', label: 'Import / export', icon: 'i-lucide-arrow-down-up' },
  { to: '/settings', label: 'Settings', icon: 'i-lucide-settings' },
]

const isActive = (to: string) =>
  to === '/' ? route.path === '/' : route.path.startsWith(to)

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen bg-default">
    <header
      class="sticky top-0 z-40 border-b border-default bg-default/80 backdrop-blur"
    >
      <div class="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-2 font-semibold">
          <UIcon name="i-lucide-boxes" class="size-5 text-primary" />
          <span class="hidden sm:inline">Records</span>
        </NuxtLink>

        <nav class="flex items-center gap-0.5 overflow-x-auto">
          <NuxtLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors"
            :class="
              isActive(item.to)
                ? 'bg-elevated font-medium text-highlighted'
                : 'text-muted hover:bg-elevated/60 hover:text-default'
            "
          >
            <UIcon :name="item.icon" class="size-4" />
            <span class="hidden md:inline">{{ item.label }}</span>
          </NuxtLink>
        </nav>

        <div class="ml-auto flex items-center gap-3">
          <IdentityModeToggle />
          <UDropdownMenu
            :items="[
              [{ label: user?.name ?? '', type: 'label' }],
              [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: logout }],
            ]"
          >
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-circle-user"
              :label="user?.name"
              class="hidden sm:flex"
            />
          </UDropdownMenu>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-[1600px] px-4 py-6">
      <slot />
    </main>
  </div>
</template>
