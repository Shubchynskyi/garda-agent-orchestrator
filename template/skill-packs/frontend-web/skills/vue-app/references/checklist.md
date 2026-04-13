# Vue App Checklist

## Component Structure

- [ ] `<script setup lang="ts">` is used consistently (or project's chosen API style is followed).
- [ ] `<style scoped>` or CSS Modules prevent style leakage to sibling components.
- [ ] Template expressions are concise; complex logic is extracted to computed properties or methods.
- [ ] Component files follow project naming convention (PascalCase or kebab-case).

## Props & Emits

- [ ] Props are declared with `defineProps<T>()` using typed interfaces.
- [ ] Object/array prop defaults use the factory-function form.
- [ ] Emits are declared with `defineEmits<T>()` with typed event signatures.
- [ ] Props are never mutated directly; updates use emits or `defineModel()`.
- [ ] Required vs optional props are explicitly marked.

## Reactivity

- [ ] `ref()` is used for primitives; `reactive()` for cohesive object state.
- [ ] `reactive()` objects are not destructured without `toRefs()` or `toRef()`.
- [ ] `computed()` getters contain no side effects.
- [ ] `watch()` / `watchEffect()` callbacks clean up side effects via `onCleanup`.
- [ ] `shallowRef()` / `shallowReactive()` are used where deep tracking is unnecessary.
- [ ] Template does not access `.value` on refs (auto-unwrapped).

## Composables

- [ ] Composable functions follow `use*` naming convention.
- [ ] Return type is explicitly typed with reactive refs and methods.
- [ ] Lifecycle hook dependencies (`onMounted`, `inject`) are documented.
- [ ] Event listeners, timers, and subscriptions are cleaned up in `onUnmounted` or `onScopeDispose`.
- [ ] Shared-state composables clearly document their singleton/per-instance semantics.

## State Management (Pinia)

- [ ] Stores define typed state, getters, and actions.
- [ ] `storeToRefs()` is used when destructuring store state.
- [ ] Derived state is a getter, not duplicated in state.
- [ ] Async actions handle errors explicitly; failures are not silently swallowed.
- [ ] Store state is not mutated outside of actions (if `strict` mode is intended).

## Router

- [ ] Non-critical views use lazy loading: `() => import('...')`.
- [ ] Navigation guards handle auth, permissions, and redirect logic without heavy sync work.
- [ ] Named routes or typed route objects are preferred over raw path strings.
- [ ] `<router-link>` is used instead of programmatic `router.push` for static navigation.
- [ ] Route meta fields are typed and validated in guards.

## Async Data & Suspense

- [ ] Components with `async setup()` or top-level `await` are wrapped in `<Suspense>`.
- [ ] Loading and error states are handled explicitly (fallback slots or error boundaries).
- [ ] In-flight requests are cancelled on unmount or parameter change.
- [ ] Data-fetching composables return loading/error refs alongside data.

## Forms & v-model

- [ ] Custom `v-model` implements `modelValue` prop + `update:modelValue` emit (or `defineModel()`).
- [ ] Named v-model bindings use `v-model:name` syntax correctly.
- [ ] Form validation runs on submit and field-blur.
- [ ] Error messages are linked to controls via `aria-describedby`.
- [ ] Disabled and loading states prevent double submission.

## Performance

- [ ] Large lists use `v-memo` or virtual scrolling where appropriate.
- [ ] Static content uses `v-once` when it never changes after mount.
- [ ] `key` attributes on `v-for` items use stable, unique identifiers (not array index).
- [ ] Heavy components are loaded with `defineAsyncComponent`.
- [ ] Watchers use `{ flush: 'post' }` only when DOM access is required.

## Build & Environment

- [ ] `vite.config.*` / `vue.config.*` alias resolution and proxy settings are correct.
- [ ] Environment variables follow `VITE_` (Vite) or `VUE_APP_` (Vue CLI) prefix convention.
- [ ] Secrets and API keys are not exposed via client-prefixed env vars.
- [ ] `vue-tsc` or `tsc` type-check passes without errors.
- [ ] Lint and test commands pass before completion.
