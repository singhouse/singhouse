<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <router-view />
</template>

<script setup>
// All app surfaces live under the router:
//   /        → HostShell (sidebar + player + lyrics)
//   /unlock  → the single-host gate
// An installed package may add more (accounts, guest-facing pages) via
// router.addRoute; see router/index.js.
</script>
