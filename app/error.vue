<script setup lang="ts">
import type { NuxtError } from '#app'

defineProps<{ error: NuxtError }>()
</script>

<template>
  <div class="err">
    <div class="card">
      <div class="card-body stack">
        <h1>{{ error.statusCode === 404 ? 'Page not found' : 'Something went wrong' }}</h1>
        <p class="muted">{{ error.statusCode === 404 ? 'This page does not exist in OracleDB Data Lab.' : error.message }}</p>
        <button class="btn primary" @click="clearError({ redirect: '/' })">Back to Overview</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.err {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.card {
  max-width: 460px;
  width: 100%;
}
</style>
