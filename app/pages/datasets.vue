<script setup lang="ts">
useHead({ title: 'Dataset Sources · OracleDB Data Lab' })
</script>

<template>
  <UiPlanned
    title="Dataset Sources"
    phase="after MVP"
    summary="Reusable dataset definitions beyond the built-in Retail Commerce blueprint."
    :features="[
      'Catalog of blueprints (retail, banking ledger, telecom CDR, IoT time series) with versioned definitions',
      'Per-dataset distribution profiles (seasonality, skew, status mix) saved and shared between runs',
      'Dataset lineage: which generation jobs produced which rows (DL_JOB_ID is already recorded today)',
      'Reference data packs (regions, categories) importable from CSV',
    ]"
  />
</template>
