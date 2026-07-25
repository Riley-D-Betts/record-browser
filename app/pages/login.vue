<script setup lang="ts">
definePageMeta({ layout: 'blank' })
useHead({ title: 'Sign in' })

const route = useRoute()
const { fetch: refreshSession } = useUserSession()

const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)

async function submit() {
  pending.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    })
    await refreshSession()
    await navigateTo((route.query.redirect as string) || '/')
  } catch (e: any) {
    error.value = e?.data?.statusMessage ?? 'Could not sign in'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center px-4">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <UIcon name="i-lucide-boxes" class="mx-auto mb-3 size-8 text-primary" />
        <h1 class="text-xl font-semibold text-highlighted">
          Technical Records Browser
        </h1>
        <p class="mt-1 text-sm text-muted">Sign in to browse and edit the catalog.</p>
      </div>

      <form class="space-y-4" @submit.prevent="submit">
        <UFormField label="Email" name="email">
          <UInput
            v-model="email"
            type="email"
            autocomplete="username"
            autofocus
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password">
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <UButton type="submit" block :loading="pending" label="Sign in" />
      </form>
    </div>
  </div>
</template>
