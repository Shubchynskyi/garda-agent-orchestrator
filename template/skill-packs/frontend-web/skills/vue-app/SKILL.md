---
name: vue-app
description: >
  Specialist skill for production Vue 3 applications. Guides correct
  Composition API usage, reactivity system contracts, single-file component
  structure, props/emits typing, composable extraction, Pinia state management,
  Vue Router guards and navigation, async data loading, form handling,
  and performance/accessibility-safe UI changes.
  Trigger phrases: "Vue", "Vue 3", "Composition API", "Options API",
  "defineProps", "defineEmits", "composable", "Pinia", "vue-router",
  "single-file component", "SFC", "ref", "reactive", "v-model", "slot",
  "provide/inject", "route guard", "store", "directive".
  Do NOT use for generic HTML/CSS work with no Vue component, reactivity,
  or routing implications, or for Nuxt-specific SSR/SSG concerns (use a
  Nuxt skill if available).
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: frontend
  triggers: Vue, Vue 3, Composition API, Options API, SFC, Pinia, vue-router, composable, ref, reactive, defineProps, defineEmits
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, frontend-accessibility, dependency-review
---

# Vue App

## Core Workflow

1. **Detect API style and Vue version.** Check `package.json` for `vue` major version and whether `@vue/composition-api` is present. Scan changed files for `<script setup>` (Composition API with `<script setup>`) vs `<script>` with `export default { ... }` (Options API or plain Composition API). Follow the project's dominant style; do not mix API styles within the same module boundary without explicit justification.
2. **Validate single-file component structure.** Each `.vue` file should have a clear `<script setup lang="ts">` (or `<script>`) block, a `<template>` block, and an optional `<style scoped>`. Confirm `scoped` or CSS Modules are used to prevent style leakage. Verify that `<template>` has a single logical root concept and does not contain business logic expressions longer than a single method call.
3. **Enforce props and emits contracts.** All components must declare props via `defineProps<T>()` with TypeScript interface or runtime validation object. Emits must be declared via `defineEmits<T>()` with typed event signatures. Never mutate props directly; use `defineModel()` or explicit emit-based update patterns for two-way binding. Verify default values use the factory-function form for object/array types.
4. **Audit reactivity correctness.** Confirm `ref()` is used for primitives, `reactive()` for objects when the entire object is the reactive unit. Flag destructuring of `reactive()` objects without `toRefs()` — this breaks reactivity. Verify `computed()` getters have no side effects. Confirm `watch()` and `watchEffect()` callbacks clean up side effects via the `onCleanup` parameter or by returning cleanup functions. Flag raw `.value` access inside `<template>` (auto-unwrapped in templates).
5. **Review composable design.** Composables (`use*` functions in `src/composables/`) must return explicitly typed reactive state and methods. They must not depend on component lifecycle implicitly; if they call `onMounted`, `onUnmounted`, or `inject`, document that requirement. Confirm composables are stateless-by-default or clearly document shared-state semantics. Verify cleanup of event listeners, timers, and subscriptions in `onScopeDispose` or `onUnmounted`.
6. **Validate state management.** Pinia stores must define state, getters, and actions with clear types. Confirm `storeToRefs()` is used when destructuring store state to preserve reactivity. Verify stores do not hold derived state that should be a getter. Check that actions handle async errors and do not silently swallow failures. If Vuex is present, confirm mutations are synchronous and actions handle async flows.
7. **Check router integration.** Verify route definitions in `src/router/` use lazy loading (`() => import(...)`) for non-critical views. Navigation guards (`beforeEach`, `beforeEnter`, `beforeRouteLeave`) must handle both `next()` callback style and return-value style correctly based on vue-router version. Confirm guards do not perform heavy synchronous work. Verify `<router-link>` uses `to` prop with named routes or typed route objects rather than raw path strings when the project uses typed routing.
8. **Audit async data loading.** Check components using `async setup()` or top-level `await` in `<script setup>` are wrapped in `<Suspense>` by their parent with a fallback. Verify loading and error states are handled explicitly. Confirm data-fetching composables cancel in-flight requests on component unmount or parameter change.
9. **Verify forms and v-model usage.** Confirm `v-model` on custom components implements the `modelValue` prop + `update:modelValue` emit contract (or `defineModel()`). Multi-value v-model uses named models (`v-model:title`). Verify form validation runs on submit and field-blur, and error messages are accessible (`aria-describedby` linked to control).
10. **Confirm build and test safety.** Run lint, type-check (`vue-tsc`), and test commands from the project. Check `vite.config.*` or `vue.config.*` for alias resolution, proxy settings, and plugin order. Verify that environment variables follow the `VITE_` prefix convention (Vite) or `VUE_APP_` prefix (Vue CLI) and secrets are not exposed to the client bundle.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Vue delivery checklist | `references/checklist.md` | Any Vue component, composable, store, or router change |

## Constraints

- Do not mutate props; use emits or `defineModel()` for parent-child state updates.
- Do not destructure `reactive()` objects without `toRefs()` or `toRef()`; this silently breaks reactivity tracking.
- Do not place side effects inside `computed()` getters; use `watch` or `watchEffect` instead.
- Do not mix Options API and Composition API within the same component without an explicit migration rationale.
- Do not use `ref()` on complex nested objects that are always mutated in-place; prefer `reactive()` or `shallowRef()` to avoid unnecessary deep tracking.
- Do not access Pinia store state via raw destructuring; use `storeToRefs()` to preserve reactivity.
- Do not eagerly import view components in router definitions; use dynamic `() => import()` for code splitting.
- Do not use `provide`/`inject` as a general-purpose state bus; prefer Pinia stores for cross-component state that outlives the provider tree.
- Do not expose secrets via `VITE_` or `VUE_APP_` prefixed environment variables.
- Treat changes to `vite.config.*`, `vue.config.*`, `src/router/index.*`, and global plugin registrations as high-risk; verify they do not break existing routes, aliases, or build output.
