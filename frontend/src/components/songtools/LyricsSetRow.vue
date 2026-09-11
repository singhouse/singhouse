<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <li class="vset" :class="{ 'vset--active': set.is_active }">
    <div class="vset__main">
      <p class="vset__line">
        <span class="vset__source">{{ set.source }}</span>
        <span v-if="set.label" class="vset__label">{{ set.label }}</span>
        <span v-if="set.is_active" class="vset__badge vset__badge--active">active</span>
        <span v-if="set.is_verified" class="vset__badge vset__badge--verified">verified</span>
      </p>
      <p class="vset__chips">
        <span v-for="chip in chips" :key="chip" class="vset__chip">{{ chip }}</span>
      </p>
    </div>

    <!-- A native disclosure rather than a hand-rolled popup: Escape and a
         second click already close it, and it needs no document listener that
         a closing panel could leave behind. -->
    <details ref="menuEl" class="vset__menu">
      <summary class="vset__menu-btn" :title="`Actions for set #${set.id}`">⋯</summary>
      <div class="vset__menu-pop" role="menu">
        <button v-if="!set.is_active" type="button" :disabled="busy" @click="pick('activate')">Activate</button>
        <button v-if="!set.is_verified" type="button" :disabled="busy" @click="pick('verify')">Verify</button>
        <button v-if="set.has_word_sync" type="button" :disabled="busy" @click="pick('repage')">Re-page</button>
        <button type="button" :disabled="busy" @click="pick('duplicate')">Duplicate</button>
        <a
          v-if="set.has_word_sync"
          class="vset__menu-link"
          :href="`/songs/${songId}/lyrics-editor/${set.id}`"
          target="_blank"
          rel="noopener"
          @click="closeMenu"
        >Edit timing</a>
        <button
          type="button"
          class="vset__menu-danger"
          :disabled="busy"
          @click="pick('delete')"
        >Delete</button>
      </div>
    </details>
  </li>
</template>

<script setup>
// One row of the VERSIONS list. Carries the same action set everywhere it is
// shown, so a host does not have to remember which surface offers Verify.
import { computed, ref } from 'vue'
import { formatServerDate } from '@/utils/serverTime'

const props = defineProps({
  set:    { type: Object, required: true },
  songId: { type: Number, required: true },
  busy:   { type: Boolean, default: false },
})

const emit = defineEmits(['action'])

const menuEl = ref(null)

// Provenance, in the order it answers "what IS this": where the words came
// from, whether the timing was fitted to a reference, what has been re-run on
// it since, and when. `anchored` is derived rather than stored: a set that
// carries plain or synced lyrics is one whose timing had something to fit to.
const chips = computed(() => {
  const ls = props.set
  const out = []
  out.push(ls.has_plain_lyrics || ls.has_synced_lyrics ? 'anchored' : 'unanchored')
  if (ls.has_word_sync) out.push('word-sync')
  const said = `${ls.label || ''} ${ls.source || ''}`
  if (/pag(e|ed|ing)/i.test(said)) out.push('paged')
  if (/re-?align/i.test(said)) out.push('realigned')
  const when = formatServerDate(ls.created_at)
  if (when) out.push(when)
  return out
})

function closeMenu() {
  if (menuEl.value) menuEl.value.open = false
}

function pick(action) {
  closeMenu()
  emit('action', { action, setId: props.set.id })
}
</script>

<style scoped>
.vset {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.45rem 0.55rem;
  border-radius: var(--radius-sm);
  background: var(--bg-glass);
  border: 1px solid var(--border-subtle);
}
.vset--active {
  border-color: var(--c-primary-border);
  background: var(--c-primary-bg);
}
.vset__main { flex: 1; min-width: 0; }
.vset__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
}
.vset__source {
  font-weight: 600;
  color: var(--text-primary);
  text-transform: capitalize;
}
.vset__label {
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  overflow-wrap: anywhere;
}
.vset__badge {
  font-size: 0.58rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.05rem 0.35rem;
  border-radius: 0.25rem;
}
.vset__badge--active { background: var(--c-primary-bg); color: var(--c-primary); }
.vset__badge--verified { background: var(--c-success-bg); color: var(--c-success); }
.vset__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.2rem;
}
.vset__chip {
  font-size: 0.62rem;
  color: var(--text-muted);
  background: var(--bg-glass);
  border: 1px solid var(--border-subtle);
  padding: 0.02rem 0.3rem;
  border-radius: 0.2rem;
}

.vset__menu { position: relative; flex-shrink: 0; }
.vset__menu-btn {
  list-style: none;
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: var(--bg-glass);
  border: 1px solid var(--border-subtle);
  line-height: 1;
}
.vset__menu-btn::-webkit-details-marker { display: none; }
.vset__menu-btn:hover { color: #fff; background: var(--bg-glass-active); }
.vset__menu-pop {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 5;
  min-width: 9.5rem;
  margin-top: 0.2rem;
  padding: 0.2rem;
  display: flex;
  flex-direction: column;
  background: #101028;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.vset__menu-pop button,
.vset__menu-link {
  text-align: left;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 0.75rem;
  padding: 0.32rem 0.45rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-decoration: none;
}
.vset__menu-pop button:hover,
.vset__menu-link:hover { background: var(--bg-glass-active); }
.vset__menu-pop button:disabled { opacity: 0.4; cursor: not-allowed; }
.vset__menu-danger { color: var(--c-error); }
</style>
