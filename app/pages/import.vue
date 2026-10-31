<script setup lang="ts">
useHead({ title: 'Import Manager · OracleDB Data Lab' })
</script>

<template>
  <UiPlanned
    title="Import Manager"
    phase="after MVP"
    summary="Load external CSV/JSON files into authorized lab schemas with the same batching, progress and job tracking as the generator."
    :features="[
      'CSV/JSON upload with column mapping and type inference preview',
      'Array-bound batched loads with commit interval, resumable jobs and error rows report',
      'Optional SQL*Loader / external table control file generation for very large files',
      'Rows tagged with the import job id for precise cleanup',
    ]"
  />
</template>
