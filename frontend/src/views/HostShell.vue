<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<template>
  <div class="app" :class="{ 'app--player-active': store.currentSong, 'app--resizing-x': isResizing, 'app--resizing-y': isVResizing }">
    <!-- ── Sidebar (Library always) ─────────────────────── -->
    <aside
      class="sidebar"
      :class="{ 'sidebar--collapsed': sidebarCollapsed, 'sidebar--resizing': isResizing }"
      :style="sidebarCollapsed ? null : { width: sidebarWidth + 'px', minWidth: sidebarWidth + 'px' }"
    >
      <!-- Collapsed rail: the mark (status dot included) + upload. The
           expanded header row lives in SongList's bar, below. -->
      <template v-if="sidebarCollapsed">
        <div class="sidebar__brand">
          <span class="brand-btn brand-btn--static" :title="apiStatusLabel">
            <BrandMark :size="32" />
            <span class="brand-dot" :class="`brand-dot--${apiStatus}`" aria-hidden="true" />
          </span>
          <button class="collapse-btn" @click="sidebarCollapsed = false" title="Expand" aria-label="Expand sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
        <div class="sidebar__nav-icons">
          <button
            type="button"
            class="nav-icon nav-icon--upload"
            title="Upload"
            aria-label="Upload files"
            @click="uploadOpen = true"
          >☁️</button>
        </div>
        <button v-if="desktopSetupAvailable" type="button" class="nav-icon" title="Set up song processing" aria-label="Set up song processing" @click="onboardingOpen = true">⚙</button>
      </template>

      <!-- Library content -->
      <div v-else class="sidebar__content">
        <SongList>
          <!-- Brand mark = account/status. The dot is the backend health
               that used to be the footer pill. -->
          <template #lead>
            <PopoverMenu label="Account and status">
              <template #trigger="{ toggle, attrs }">
                <button
                  type="button"
                  class="brand-btn"
                  :title="`${BRAND_NAME} — ${apiStatusLabel}`"
                  :aria-label="`Account and status (${apiStatusLabel})`"
                  v-bind="attrs"
                  @click="toggle"
                >
                  <BrandMark :size="32" decorative />
                  <span class="brand-dot" :class="`brand-dot--${apiStatus}`" aria-hidden="true" />
                </button>
              </template>
              <template #default="{ close }">
                <p class="ui-menu__section">Status</p>
                <div class="acct-row">
                  <div class="connection-status" :class="`connection-status--${apiStatus}`">
                    <div class="connection-dot" />
                    <span>{{ apiStatusLabel }}</span>
                  </div>
                </div>
                <!-- The queue provider's own status indicator, if it has one.
                     The rotation's is public-tunnel health; core's queue has
                     nothing to report beyond the backend line above. -->
                <!-- The pill may render nothing (e.g. no tunnel configured);
                     .acct-row:empty keeps that from leaving a padded gap. -->
                <div v-if="queueProvider?.statusPill" class="acct-row acct-row--pill"><component :is="queueProvider.statusPill" /></div>
                <hr class="ui-menu__sep" />
                <p class="ui-menu__section">Signed in</p>
                <div class="acct-row acct-row--user" :title="session.identity?.name || 'Host'">
                  {{ session.identity?.name || 'Host' }}
                </div>
                <template v-if="desktopSetupAvailable">
                  <hr class="ui-menu__sep" />
                  <button type="button" class="ui-menu__item" @click="close(); onboardingOpen = true">
                    <span class="ui-menu__icon" aria-hidden="true">⚙</span>Set up song processing
                  </button>
                </template>
                <template v-if="showExit">
                  <hr class="ui-menu__sep" />
                  <button type="button" class="ui-menu__item ui-menu__item--danger" @click="close(); exitSession()">
                    <span class="ui-menu__icon" aria-hidden="true">⏻</span>{{ exitTitle }}
                  </button>
                </template>
              </template>
            </PopoverMenu>
          </template>

          <template #actions>
            <PopoverMenu role="menu" align="end" label="Add to library">
              <template #trigger="{ toggle, attrs, open }">
                <button
                  type="button"
                  class="add-btn"
                  :class="{ 'add-btn--open': open }"
                  title="Add songs to the library"
                  v-bind="attrs"
                  @click="toggle"
                >+ Add <span class="caret" aria-hidden="true">▾</span></button>
              </template>
              <template #default="{ close }">
                <button type="button" role="menuitem" class="ui-menu__item" @click="close(); uploadOpen = true">
                  <span class="ui-menu__icon" aria-hidden="true">⤒</span>Upload files…
                </button>
                <!-- Import from a Plex media server the host runs themselves.
                     Host affordance only: it reads the operator's own server
                     through the operator's own credential. -->
                <button type="button" role="menuitem" class="ui-menu__item" @click="close(); plexOpen = true">
                  <span class="ui-menu__icon" aria-hidden="true">🎞</span>Import from Plex…
                </button>
              </template>
            </PopoverMenu>
          </template>

          <template #trail>
            <button class="collapse-btn" @click="sidebarCollapsed = true" title="Collapse" aria-label="Collapse sidebar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
          </template>

          <template #notice>
            <div v-if="apiStatus === 'offline'" class="offline-banner" role="status">
              <span aria-hidden="true">⚠</span>
              <span>{{ apiStatusLabel }} — reconnecting…</span>
            </div>
          </template>
        </SongList>
      </div>

      <!-- Resize handle -->
      <div
        v-if="!sidebarCollapsed"
        class="sidebar__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        :aria-valuenow="sidebarWidth"
        :aria-valuemin="MIN_PANEL_WIDTH"
        tabindex="0"
        @mousedown.prevent="startResize"
        @dblclick="resetSidebarWidth"
        @keydown="onResizeKey"
      />
    </aside>

    <!-- ── Main content ────────────────────────────────── -->
    <main class="main">
      <!-- Player panel (shown when a song is selected) -->
      <Transition name="slide-up">
        <section v-if="store.currentSong" class="player-panel">
          <AudioPlayer
            :song="store.currentSong"
            @lyrics-loaded="val => player.setLyrics(val)"
            @time-update="val => player.setTime(val)"
            @lyrics-offset-change="val => player.setOffset(val)"
            @ended="onSongEnded"
          />
        </section>
      </Transition>

      <!-- Songless-pick notice. When the current entry has no loadable song,
           the pick watcher leaves the deck alone — and a silent no-op there
           reads as "advance did nothing" and caused a double-advance past a
           singer, so the state is surfaced here instead. -->
      <div v-if="songlessPick" class="pick-notice">
        <span class="pick-notice__icon" aria-hidden="true">🎤</span>
        <span v-if="songlessPick.songText" class="pick-notice__text">
          <strong>{{ songlessPick.label || 'Current singer' }} is up</strong> — “{{ songlessPick.songText }}” isn’t linked to a library song, so the deck is unchanged.
        </span>
        <span v-else class="pick-notice__text">
          <strong>{{ songlessPick.label || 'Current singer' }} is up</strong> and hasn’t picked a song yet — the deck is unchanged.
        </span>
        <button
          type="button"
          class="pick-notice__dismiss"
          aria-label="Dismiss"
          @click="songlessPick = null"
        >✕</button>
      </div>

      <!-- Lyrics + queue split -->
      <div class="content-split" ref="splitRef">
        <!-- Lyrics area (top) -->
        <section class="lyrics-area" :style="{ height: lyricsHeightPct + '%' }">
          <!-- Projector control. Deliberately OUTSIDE the song-gated player
               panel: the projector gets opened and aimed BEFORE the first
               song of the night, and the player panel does not exist until a
               song is loaded — a button inside it would be unreachable in
               exactly the state the host needs it. Floats over the lyrics
               area so it is reachable from both the welcome pane and a
               running song. -->
          <div class="stage-tools">
            <!-- Display settings: what the host tunes once per venue, not
                 per song — hence a popover rather than always-on controls. -->
            <PopoverMenu align="end" label="Display settings">
              <template #trigger="{ toggle, attrs, open }">
                <button
                  type="button"
                  class="popout-btn popout-btn--float popout-btn--display"
                  :class="{ 'popout-btn--active': open }"
                  title="Backdrop and projector"
                  v-bind="attrs"
                  @click="toggle"
                >Display <span class="caret" aria-hidden="true">▾</span></button>
              </template>
              <template #default="{ close }">
                <p class="ui-menu__section">Backdrop</p>
                <label class="host-select" title="Audio-reactive backdrop drawn behind the canvas lyrics.">
                  <span class="host-select__label">Style</span>
                  <!-- :value + @change, NOT v-model: v-model's updated hook
                       re-applies option.selected on every render, which strobes
                       an open native dropdown. :value only writes the DOM when
                       the value truly changes (on selection, which closes the
                       popup). This shell also deliberately no longer reads
                       player.currentTime anywhere in its template (see the
                       lyrics-host comment below), so it no longer re-renders at
                       rAF rate while a song plays — both halves matter for
                       keeping Firefox's native select popup stable. -->
                  <select
                    :value="backdropChoice"
                    @change="hostSettings.backdrop = $event.target.value"
                    class="host-select__input"
                  >
                    <option v-for="o in visualizerOptions" :key="o.id" :value="o.id">{{ o.name }}</option>
                  </select>
                </label>
                <label
                  v-if="backdropChoice !== 'none'"
                  class="host-select"
                  title="Which audio the backdrop reacts to."
                >
                  <span class="host-select__label">Reacts to</span>
                  <select
                    :value="hostSettings.audioSource"
                    @change="hostSettings.audioSource = $event.target.value"
                    class="host-select__input"
                  >
                    <option value="mix">Full mix</option>
                    <option value="inst">Instrumental</option>
                    <option value="vocals">Lead vocals</option>
                  </select>
                </label>
                <!-- Standalone projector page. It arrives with the queue system
                     that needs it (a rotation's now-singing/on-deck board);
                     core's projector is the popout, so the link is only offered
                     when the route actually exists. -->
                <template v-if="hasScreenRoute">
                  <hr class="ui-menu__sep" />
                  <p class="ui-menu__section">Screens</p>
                  <router-link to="/screen" target="_blank" class="ui-menu__item" @click="close()">
                    <span class="ui-menu__icon" aria-hidden="true">📺</span>Open projector view
                  </router-link>
                </template>
              </template>
            </PopoverMenu>
            <button
              class="popout-btn popout-btn--icon popout-btn--float"
              :class="{ 'popout-btn--active': lyricsWin.isOpen.value }"
              :title="lyricsWin.isOpen.value ? 'Close lyrics window' : 'Pop out lyrics to a separate window (double-click in popup or F11 to fullscreen)'"
              :aria-label="lyricsWin.isOpen.value ? 'Close lyrics window' : 'Pop out lyrics'"
              @click="toggleWindow"
            >⛶</button>
          </div>

          <Transition name="fade">
            <div v-if="!store.currentSong" class="welcome">
              <BrandLogo :size="96" class="welcome__logo" />
              <p class="welcome__sub">Upload a song or select from your library to begin</p>

              <div class="welcome__steps">
                <div class="welcome__step">
                  <span class="step-num">1</span>
                  <span>Upload an audio file (MP3, FLAC, WAV) or a karaoke video</span>
                </div>
                <div class="welcome__step">
                  <span class="step-num">2</span>
                  <span>Wait for stems to be separated</span>
                </div>
                <div class="welcome__step">
                  <span class="step-num">3</span>
                  <span>Click a song and sing along!</span>
                </div>
              </div>

              <button type="button" class="btn btn-primary welcome__cta" @click="uploadOpen = true">
                ☁️ Upload a Song
              </button>
            </div>
          </Transition>

          <!-- Main lyrics display: always visible when there's a song,
               independent of the popout. -->
          <!-- ScreenStage reads the play clock from the player store itself.
               Do NOT pass currentTime/offset props here: reading
               player.currentTime in THIS template re-renders the whole shell
               at rAF rate while a song plays, and that churn is what made the
               Display's native <select> dropdowns flash and drop picks in
               Firefox (Vue force-visits `value` props on every render — the
               write is guarded, the visit is not). -->
          <div v-show="store.currentSong" class="lyrics-host">
            <ScreenStage />
          </div>
        </section>

        <!-- Vertical resize handle -->
        <div
          class="vsplit-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize queue panel"
          :aria-valuenow="Math.round(lyricsHeightPct)"
          aria-valuemin="20"
          aria-valuemax="90"
          tabindex="0"
          @mousedown.prevent="startVResize"
          @dblclick="resetSplit"
          @keydown="onVResizeKey"
        >
          <div class="vsplit-grip" />
        </div>

        <!-- Queue panel (bottom): the registered provider's, or core
             BasicManualQueue. Whichever mounts owns its own poll lifecycle. -->
        <section class="queue-area">
          <component :is="queueProvider.panel" v-if="queueProvider" />
          <QueuePanel v-else />
        </section>
      </div>

      <!-- Hidden popout host. The inner <ScreenStage> is the element that
           gets moved into the popup window via useLyricsWindow. The main
           lyrics-host above is a separate instance, so it keeps rendering in
           the host window even while popped out. The wrapper stays
           display:none always — even when the inner element is back here
           after the popup closes — because only the popup ever shows it. -->
      <div class="lyrics-popout-stage">
        <div ref="lyricsPopoutHostRef" class="lyrics-popout-host">
          <ScreenStage
            :show-qr="showJoinQr"
            :stage-epoch="popoutEpoch"
          />
        </div>
      </div>
    </main>

    <!-- ── Song tools dock ─────────────────────────────────────────────
         A dock rather than a modal, and a sibling of <main> rather than a
         child of the library: the whole point is that it stays open while the
         host browses the list, compares versions and starts jobs on more than
         one song. Keyed by song id so re-pointing it at another song gets a
         clean component instead of the previous song's tab state. -->
    <aside v-if="songTools.songId" class="tools-dock">
      <SongToolsPanel
        :key="songTools.songId"
        :song-id="songTools.songId"
        :initial-tab="songTools.tab"
        @close="songTools.close()"
      />
    </aside>

    <DesktopOnboarding v-if="desktopSetupAvailable" :open="onboardingOpen" @background="onboardingOpen = false" @lyrics-saved="features.load({ force: true })" @open="onboardingOpen = true" @close="onboardingOpen = false" @add-song="openOnboardingImport" />
    <!-- Upload modal. Lives inside HostShell so AudioPlayer keeps playing
         while the user uploads — opening it does not unmount the player. -->
    <Modal :visible="uploadOpen" size="lg" @close="uploadOpen = false">
      <div class="upload-modal">
        <div class="upload-modal__title">
          <span class="title-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <h2>Add files</h2>
        </div>
        <UploadZone @close="uploadOpen = false" />
      </div>
    </Modal>

    <!-- Plex import modal. Rendered lazily: opening it is what fetches the
         settings and the library list. -->
    <Modal :visible="plexOpen" size="lg" @close="plexOpen = false">
      <PlexImportModal v-if="plexOpen" />
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSongsStore } from '@/stores/songs'
import { useSongToolsStore } from '@/stores/songTools'
import { usePlayerStore } from '@/stores/player'
import { useHostSettings } from '@/stores/hostSettings'
import { listVisualizers } from '@/stage/visualizers'
import { useLyricsWindow, getScreens } from '@/composables/useLyricsWindow'
import { useSessionStore } from '@/stores/session'
import { getSlot, slotHasContent } from '@/plugins/slots'
import { getSignOutHandler } from '@/auth/gate'
import { BRAND_NAME } from '@/brand'
import BrandMark from '@/components/BrandMark.vue'
import BrandLogo from '@/components/BrandLogo.vue'
import PopoverMenu from '@/components/ui/PopoverMenu.vue'
import SongList from '@/components/SongList.vue'
import SongToolsPanel from '@/components/SongToolsPanel.vue'
import QueuePanel from '@/components/QueuePanel.vue'
import AudioPlayer from '@/components/AudioPlayer.vue'
import ScreenStage from '@/components/ScreenStage.vue'
import UploadZone from '@/components/UploadZone.vue'
import PlexImportModal from '@/components/PlexImportModal.vue'
import Modal from '@/components/ui/Modal.vue'
import { useFeaturesStore } from '@/stores/features'
import DesktopOnboarding from '@/components/DesktopOnboarding.vue'
import { useHistoryStore } from '@/stores/history'

// Which queue system this build ships. An installed package may register
// a 'queue-provider' — an object, not a component:
//
//   panel          Component  — mounted in the queue area instead of QueuePanel
//   statusPill     Component? — optional indicator for the account/status
//                  popover behind the sidebar's brand mark
//   useCurrent()   ComputedRef<{ key, songId, label?, songText? } | null> —
//                  who is up now. `key` is opaque here: the shell only ever
//                  compares it for equality. It MUST be a string-safe scalar
//                  containing no '|' — pickKey() below encodes it into a
//                  '|'-delimited string and compares a split('|')[0] substring
//                  back out, so a '|' in the key silently breaks change
//                  detection. MUST be called from setup(). `label` (the
//                  singer's display name) and `songText` (their free-text
//                  pick, null when unset) are display-only and OPTIONAL —
//                  omitting them is legal, the shell defaults both to null;
//                  they feed the songless-pick banner and nothing else.
//   useAdvancing() ComputedRef<boolean> — true while the queue is mid-cycle
//   onSongEnded(info) — handed the AudioPlayer `ended` payload
//   onSongStarted(info)? — optional; called with { entryId, songId } when the
//                  deck first starts PLAYING the provider's current pick —
//                  NOT when it merely loads. The notification is ARMED where
//                  the pick reaches the deck (either load site — the live
//                  pick watcher and the deferred-stash apply — and also
//                  load-free when a NEW entry's pick is already the loaded
//                  song: consecutive singers, same song, still a new
//                  performance), and FIRED at the deck's next transition to
//                  'playing', at most once per arming — pause/resume does not
//                  repeat it, and it never arms for the same entry re-picking
//                  the loaded song. Play-time (not load-time) on purpose:
//                  every open host shell auto-loads the current pick (that is
//                  what keeps a second window — a projector display — in
//                  sync), so a load-time signal fires once PER OPEN WINDOW;
//                  only the shell whose deck actually plays owns the
//                  performance. entryId is the same opaque key useCurrent()
//                  reports; a provider that keeps its own history can use it
//                  to tell a live notification from a stale one.
//
// Nothing is registered in a core assembly, and every use of it below is
// either guarded or inert. Read once at setup: registration happens before the
// app is created (main.js), so it cannot change under a mounted shell.
const queueProvider = getSlot('queue-provider')
const currentPick = queueProvider?.useCurrent() ?? null
const advancing = queueProvider?.useAdvancing?.() ?? null

// The projector QR advertises a join surface, which only exists when a queue
// system that admits guests is installed.
const showJoinQr = slotHasContent('queue-provider')

const router = useRouter()
const store = useSongsStore()
const songTools = useSongToolsStore()
const player = usePlayerStore()
const hasScreenRoute = router.hasRoute('screen')
const hostSettings = useHostSettings()
const visualizerOptions = listVisualizers()
// A stored id the registry can't resolve (a private visualizer this install
// doesn't have) matches no <option>, which renders the select BLANK. The stage
// already falls back to the flat fill for the same id, so show what it renders.
const backdropChoice = computed(() =>
  visualizerOptions.some(o => o.id === hostSettings.backdrop) ? hostSettings.backdrop : 'none',
)
const lyricsWin = useLyricsWindow()
const session = useSessionStore()
// Core-only play history. Inert in a premium build: the store is only
// ever driven from the queueProvider-absent branches below.
const history = useHistoryStore()
const lyricsPopoutHostRef = ref(null)
const splitRef = ref(null)
const lastTargetScreen = ref(null)

// Exit affordance. In multi-user mode premium installs a real logout handler;
// in single-host mode the exit is the gate Lock (only when a password is set).
// The two are mutually exclusive per build, so prefer the premium logout.
const signOutHandler = getSignOutHandler()
const exitTitle = signOutHandler ? 'Sign out' : 'Lock'
const showExit = computed(() => !!signOutHandler || session.gateEnabled)

async function exitSession() {
  if (signOutHandler) {
    await signOutHandler()
    return
  }
  await session.lock()
  router.replace({ name: 'unlock' })
}

// ── Popout stage re-key ─────────────────────────────────────────────────────
// Popping out physically moves .lyrics-popout-host (and the ScreenStage inside
// it) into the popup window's document — a raw DOM move, so Vue never
// remounts anything. The canvas therefore keeps the 2D context it acquired in
// whichever document it was in at mount time, and a context killed by the move
// stays dead for the rest of the show. Bumping this epoch re-keys the inner
// KaraokeStage so it remounts and calls getContext() fresh.
//
// `lyricsWin.isOpen` is the correct signal in BOTH directions, and its timing
// is what makes this work: useLyricsWindow sets it true only AFTER
// `w.document.body.appendChild(element)`, and back to false only AFTER
// returnToHost() has re-inserted the element under its original parent. So by
// the time this watcher runs — a tick later, on the reactivity flush — the
// element is already in its destination document, and the remounted stage's
// onMounted (a post-flush hook, after the new canvas is inserted) reads the
// right window for getContext(), devicePixelRatio, and requestAnimationFrame.
const popoutEpoch = ref(0)
watch(lyricsWin.isOpen, () => { popoutEpoch.value += 1 })

async function toggleWindow() {
  if (lyricsWin.isOpen.value) {
    lyricsWin.close()
    return
  }
  if (!lyricsPopoutHostRef.value) return
  try {
    // Prefer a non-primary screen if one's connected (the projector).
    const { screens, primary } = await getScreens()
    const target = screens.find(s => !s.isPrimary) || primary
    lastTargetScreen.value = target?.isPrimary ? null : target
    await lyricsWin.open(lyricsPopoutHostRef.value, {
      title: `${BRAND_NAME} — Lyrics`,
      screen: lastTargetScreen.value,
    })
  } catch (e) {
    console.error('Window open failed:', e)
    alert(e.message || 'Could not open lyrics window.')
  }
}

// Auto-load whatever song the queue provider's "current" pick points at. With
// no provider registered there is no current pick, and this whole complex is
// inert: `currentPick` is null, the key below never changes, and neither
// watcher ever fires.
//
// Deferred while the deck is busy. Advancing promotes the on-deck singer to
// `current` the instant the previous song's audio ends — before they've picked
// anything, and without their phone telling them they're up. If the host starts
// playing something in that gap, the singer's eventual pick lands here as a
// songId change under the *same* key, and loading it immediately tears down
// the running audio engine mid-performance. Stash it and apply on stop instead;
// dropping it outright would make the singer's pick look lost.
//
// The stash is keyed by the provider's KEY, not just song id: if the host
// advances past this singer while the deck is busy, the pick is stale and gets
// dropped rather than loaded for whoever is up now.
const pendingPick = ref(null) // { entryId, songId } | null

// The armed onSongStarted notification: set where a pick reaches the deck,
// fired at the deck's next transition to 'playing' (watcher below), cleared
// when it fires or when a manual library load supersedes the pick. History
// taught us the hard version of why this is play-time and not load-time: a
// second host window open for the projector auto-loads every pick too, and a
// load-time notification wrote one history row per open window for every
// performance of a show. Only the shell whose deck actually plays owns the
// performance. A newer arming simply overwrites an unfired older one — the
// provider's own entryId staleness check is the second layer for anything
// that slips through.
const armedStart = ref(null) // { entryId, songId } | null

// The current entry having NOTHING loadable — the singer hasn't picked, or
// picked free text with no library link. The watcher below can't load anything
// in that state, and a silent no-op there caused a double-advance past a
// singer: advancing appeared to change nothing, so it got repeated.
// Surfaced as a dismissable banner in the template.
// `label`/`songText` are optional on the provider seam — a provider may report
// neither, and the banner copy falls back. Known limit, accepted: songText
// changing while key and songId stay the same won't refresh the banner until
// the next key change — pickKey deliberately encodes only key|songId.
const songlessPick = ref(null) // { label: string|null, songText: string|null } | null

// Watched as a composite STRING so the callback only fires on a real change.
// A polling provider hands back a fresh object each tick, so an array/object
// getter here would re-fire every poll — and with the deck idle that would
// re-load the pick's song over whatever the host had just chosen by hand, on a
// loop. Values are read fresh below so they keep their original types; the key
// is only a change detector.
const pickKey = () =>
  `${currentPick?.value?.key ?? ''}|${currentPick?.value?.songId ?? ''}`

watch(pickKey, (key, prevKey) => {
  const entryId = currentPick?.value?.key ?? null
  const songId = currentPick?.value?.songId

  // Retire a stash belonging to THIS entry FIRST, ahead of the early returns
  // below. The singer reverting to the song already loaded, or clearing their
  // pick outright, both hit those returns — and would otherwise leave the old
  // stash armed to load a song they had abandoned at the next stop.
  if (pendingPick.value && pendingPick.value.entryId === entryId) {
    pendingPick.value = null
  }

  if (!songId) {
    // Someone IS up but there's nothing to load → tell the host why the deck
    // is unchanged. No entry at all (queue empty) → nothing to announce.
    songlessPick.value = entryId != null
      ? {
          label: currentPick?.value?.label ?? null,
          songText: currentPick?.value?.songText ?? null,
        }
      : null
    return
  }
  // A loadable pick arrived (even one that defers or needs no load below):
  // the "nothing to load" condition is over.
  songlessPick.value = null

  const entryChanged = String(entryId ?? '') !== (prevKey ?? '').split('|')[0]

  // Song already in the deck: for the SAME entry that's a revert or a poll
  // echo — nothing new. For a NEW entry it is a new performance that happens
  // to need no load (back-to-back singers doing the same crowd-pleaser), and
  // the provider must still hear about it below or that play is invisible to
  // any history the provider keeps.
  const alreadyLoaded = songId === store.currentSong?.id
  if (alreadyLoaded && !entryChanged) return

  // A PLAYING deck is never interrupted, whatever changed. A new key is NOT a
  // host-only "we're moving on" signal: the rotation backend reassigns
  // status='current' to whoever lands at position 0 on ANY reorder
  // (api/rotation.py), so dragging a latecomer to the top mid-song — a routine
  // move — would otherwise call loadSong() and cut the audio dead. The 5s
  // poll can surface another operator's change the same way.
  //
  // A PAUSED deck defers only for the same singer swapping their own pick
  // (pausing is banter or a mic fix, not "done"). A paused deck plus a new
  // singer is the Advance case, which must load rather than strand: pause →
  // Advance previously stashed the pick and left the host with no way out but
  // Stop.
  const deckBusy =
    player.playState === 'playing' ||
    (player.playState === 'paused' && !entryChanged)

  if (deckBusy) {
    // entryChanged rides along so the stash apply below can tell a new
    // performance of the already-loaded song (notify, no load) from the same
    // entry re-picking it (neither).
    pendingPick.value = { entryId, songId, entryChanged }
    return
  }
  pendingPick.value = null
  if (!alreadyLoaded) store.loadSong({ id: songId })
  armedStart.value = { entryId, songId }
})

// The double-load this used to produce is what `useAdvancing()` exists for. At
// a natural end-of-track the deck reaches 'stopped' while the provider's
// advance is still in flight, and the key still names the OUTGOING singer at
// that instant — so a stash would apply here and then be superseded a few
// hundred ms later when the advance lands and the watcher above loads the new
// singer's song. Two loadSong calls, two stem fetches, a visible "Loading
// stems…" flash. Holding off while advancing leaves exactly one load: the one
// for whoever is actually up. The stale stash is not applied later either —
// the key check below drops it at the next stop.
watch(
  () => player.playState,
  (state) => {
    if (state !== 'stopped' || !pendingPick.value) return
    if (advancing?.value) return
    const { entryId, songId, entryChanged } = pendingPick.value
    pendingPick.value = null
    // Stale if the queue moved past this singer while the deck was busy —
    // don't load a song for someone who is no longer up.
    if (entryId !== (currentPick?.value?.key ?? null)) return
    const alreadyLoaded = songId === store.currentSong?.id
    if (!alreadyLoaded) store.loadSong({ id: songId })
    // Arm on a load, and on a NEW entry whose song needed no load (the
    // back-to-back same-song case) — but never for the same entry re-picking
    // what's already up, which would announce a performance that isn't one.
    if (!alreadyLoaded || entryChanged) {
      armedStart.value = { entryId, songId }
    }
  },
)

// Whether the CURRENT entry has already had a performance announced. Gates
// the walk-up fallback below: one play per turn, attributed at first play.
// Reset when a different entry becomes current, so a singer's next round is
// eligible again. Known limit: entries keep their key across rounds, so a
// SOLE-entry rotation never sees a key change and that singer's walk-up
// eligibility never resets — accepted; armed picks are unaffected.
const startedForCurrentEntry = ref(false)
watch(() => currentPick?.value?.key, (key, prev) => {
  if (key !== prev) startedForCurrentEntry.value = false
})

// The play-start moment: this is where onSongStarted actually FIRES.
//
// Armed pick playing → announce it. No armed pick (or the deck is playing
// something else): singers walk up and want a different song all the time,
// and the host serves that by loading it from the library directly — no
// phone, no pick. The first play while an entry is current and unannounced
// is that singer's performance, whatever song is in the deck. After one
// announcement the entry is spent: a pause/resume, a restart, or filler
// played after their song attributes nothing further. The known cost of the
// walk-up rule: filler played while a fresh singer is still deciding gets
// attributed to them — an accepted trade-off; revisit if it bites.
watch(
  () => player.playState,
  (state, prevState) => {
    if (state !== 'playing') return
    // paused → playing is a RESUME — or the pause/play bounce a mid-song
    // seek produces — never a first play: every load lands the deck at
    // 'stopped' (the currentSong watcher's player.clear() below), so a
    // genuine first play always arrives from 'stopped'. Without this guard,
    // a resume after a routine mid-song entry change (reorder, advance)
    // would fall into the walk-up branch and pin the PLAYING song — already
    // announced for its own singer — on whoever is current now.
    if (prevState === 'paused') return
    const songId = store.currentSong?.id
    if (songId == null) return
    const armed = armedStart.value
    if (armed && armed.songId === songId) {
      armedStart.value = null
      queueProvider?.onSongStarted?.({ entryId: armed.entryId, songId })
      // A stale arming (rotation moved past that entry) must not mark the
      // NEW current entry as announced — its own play hasn't happened.
      if (armed.entryId === (currentPick?.value?.key ?? null)) {
        startedForCurrentEntry.value = true
      }
      return
    }
    // An arming that does NOT match the playing song is a pick whose load is
    // still in flight (a genuine manual substitution disarms via the
    // currentSong watcher below the moment its load lands): the host pressed
    // play on the outgoing song mid-advance. Recording that would pin the
    // wrong song on the new singer — stay silent and let the armed load land.
    if (armed) return
    const entryId = currentPick?.value?.key ?? null
    if (entryId == null || startedForCurrentEntry.value) return
    // A stashed pick naming the current entry is proof this singer is NOT a
    // walk-up — their pick just hasn't reached the deck yet. Whatever is
    // playing now belongs to the performance before theirs.
    if (pendingPick.value && pendingPick.value.entryId === entryId) return
    // Walk-up substitution: the deck is playing a song the current entry
    // never picked (host loaded it from the library — no phone, no pick).
    // Announce the song actually playing for the singer who is actually up.
    startedForCurrentEntry.value = true
    queueProvider?.onSongStarted?.({ entryId, songId })
  },
)

// A finished (or stopped) performance. A queue provider decides what that means
// (advance, and its own history). With no provider, core consumes it directly:
// completeIfPending flips the play's completed flag on a natural end. The guard
// keeps this branch inert in premium — where currentHistoryId is never set
// anyway, since QueuePanel (its only writer) mounts only in core.
function onSongEnded(info) {
  if (queueProvider) {
    queueProvider.onSongEnded?.(info)
    return
  }
  history.completeIfPending(info)
}

const sidebarCollapsed = ref(false)
const uploadOpen = ref(false)
const features = useFeaturesStore()
const desktopSetupAvailable = window.karaokeDesktop?.managedSetup === true
const onboardingOpen = ref(false)
let stopSetupListener
function openOnboardingImport() { onboardingOpen.value = false; uploadOpen.value = true }
function showProcessingSetup() { onboardingOpen.value = true }
onMounted(async () => {
  if (!desktopSetupAvailable) return
  stopSetupListener = window.karaokeDesktop.onOpenSetup?.(showProcessingSetup)
  try {
    const preferences = await window.karaokeDesktop.getOnboardingState()
    onboardingOpen.value = preferences.skipped !== true && preferences.step !== 'ready'
  } catch { /* Development desktop keeps its explicitly configured environment. */ }
})
onBeforeUnmount(() => stopSetupListener?.())
const plexOpen = ref(false)

const MIN_PANEL_WIDTH = 300
const DEFAULT_SIDEBAR_WIDTH = 320
const SIDEBAR_WIDTH_KEY = 'karaoke:sidebarWidth'

function loadSavedWidth() {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SIDEBAR_WIDTH
  return Math.max(MIN_PANEL_WIDTH, raw)
}

const sidebarWidth = ref(loadSavedWidth())
const isResizing = ref(false)

function clampWidth(w) {
  const max = Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_PANEL_WIDTH)
  return Math.min(max, Math.max(MIN_PANEL_WIDTH, w))
}

function onResizeMove(e) {
  sidebarWidth.value = clampWidth(e.clientX)
}

function stopResize() {
  if (!isResizing.value) return
  isResizing.value = false
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
}

function startResize() {
  if (sidebarCollapsed.value) return
  isResizing.value = true
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', stopResize)
}

function resetSidebarWidth() {
  sidebarWidth.value = DEFAULT_SIDEBAR_WIDTH
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
}

function onResizeKey(e) {
  const step = e.shiftKey ? 32 : 8
  if (e.key === 'ArrowLeft')  { sidebarWidth.value = clampWidth(sidebarWidth.value - step); e.preventDefault() }
  else if (e.key === 'ArrowRight') { sidebarWidth.value = clampWidth(sidebarWidth.value + step); e.preventDefault() }
  else if (e.key === 'Home')  { sidebarWidth.value = MIN_PANEL_WIDTH; e.preventDefault() }
  else if (e.key === 'End')   { sidebarWidth.value = clampWidth(window.innerWidth); e.preventDefault() }
  else return
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
}

function onWindowResize() {
  const next = clampWidth(sidebarWidth.value)
  if (next !== sidebarWidth.value) sidebarWidth.value = next
}

// ── Vertical split (lyrics ↕ queue) ─────────────────────────────
const SPLIT_KEY = 'karaoke:lyricsHeightPct'
const DEFAULT_LYRICS_PCT = 65
const MIN_LYRICS_PCT = 20
const MAX_LYRICS_PCT = 90

function loadSavedSplit() {
  const raw = Number(localStorage.getItem(SPLIT_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LYRICS_PCT
  return Math.min(MAX_LYRICS_PCT, Math.max(MIN_LYRICS_PCT, raw))
}

const lyricsHeightPct = ref(loadSavedSplit())
const isVResizing = ref(false)

function clampPct(p) {
  return Math.min(MAX_LYRICS_PCT, Math.max(MIN_LYRICS_PCT, p))
}

function onVResizeMove(e) {
  const el = splitRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.height <= 0) return
  const pct = ((e.clientY - rect.top) / rect.height) * 100
  lyricsHeightPct.value = clampPct(pct)
}

function stopVResize() {
  if (!isVResizing.value) return
  isVResizing.value = false
  window.removeEventListener('mousemove', onVResizeMove)
  window.removeEventListener('mouseup', stopVResize)
  localStorage.setItem(SPLIT_KEY, String(lyricsHeightPct.value))
}

function startVResize() {
  isVResizing.value = true
  window.addEventListener('mousemove', onVResizeMove)
  window.addEventListener('mouseup', stopVResize)
}

function resetSplit() {
  lyricsHeightPct.value = DEFAULT_LYRICS_PCT
  localStorage.setItem(SPLIT_KEY, String(lyricsHeightPct.value))
}

function onVResizeKey(e) {
  const step = e.shiftKey ? 5 : 2
  if (e.key === 'ArrowUp')        { lyricsHeightPct.value = clampPct(lyricsHeightPct.value - step); e.preventDefault() }
  else if (e.key === 'ArrowDown') { lyricsHeightPct.value = clampPct(lyricsHeightPct.value + step); e.preventDefault() }
  else if (e.key === 'Home')      { lyricsHeightPct.value = MIN_LYRICS_PCT; e.preventDefault() }
  else if (e.key === 'End')       { lyricsHeightPct.value = MAX_LYRICS_PCT; e.preventDefault() }
  else return
  localStorage.setItem(SPLIT_KEY, String(lyricsHeightPct.value))
}

const apiStatus = ref('unknown')
const apiStatusLabel = computed(() => ({
  unknown: 'Checking...',
  online:  'Backend online',
  offline: 'Backend offline'
}[apiStatus.value]))

let healthInterval = null

onMounted(async () => {
  // Ensure identity is loaded. In single-host mode the router guard already
  // probed; in multi-user mode the premium guard drives its own store, so
  // seed the session store here for the sidebar identity + Lock affordance.
  if (session.status === 'unknown') session.probe()
  await store.fetchSongs()
  checkApiHealth()
  healthInterval = setInterval(checkApiHealth, 30000)
  // No queue polling here: whichever panel is mounted owns its own lifecycle,
  // which is the only way the shell can stay ignorant of what endpoints the
  // installed queue system even has.
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  clearInterval(healthInterval)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  window.removeEventListener('mousemove', onVResizeMove)
  window.removeEventListener('mouseup', stopVResize)
  window.removeEventListener('resize', onWindowResize)
})

watch(() => store.currentSong?.id, (id) => {
  // An explicit song load supersedes any stashed pick, and this reset must
  // happen BEFORE player.clear(): clear() sets playState to 'stopped', which
  // is exactly the transition the pending-apply watcher above listens for.
  // Without it, clicking a song in the library while a pick was stashed would
  // silently swap the host's choice for the stashed one a tick later.
  pendingPick.value = null
  // Same supersede logic for the armed start-notify: it survives only its
  // OWN pick's load landing. Any other song taking the deck is the host
  // choosing by hand — the walk-up fallback in the playState watcher owns
  // attribution from here.
  if (armedStart.value && armedStart.value.songId !== id) armedStart.value = null
  player.clear()
  // The canvas stage model arrives via AudioPlayer's lyrics-loaded → setLyrics.
})

async function checkApiHealth() {
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(3000) })
    apiStatus.value = res.ok ? 'online' : 'offline'
  } catch {
    apiStatus.value = 'offline'
  }
}
</script>

<style scoped>
.app { display: flex; height: 100vh; overflow: hidden; }
.app--resizing-x { cursor: col-resize; user-select: none; }
.app--resizing-x * { cursor: col-resize !important; }
.app--resizing-y { cursor: row-resize; user-select: none; }
.app--resizing-y * { cursor: row-resize !important; }

.sidebar {
  width: 320px; min-width: 320px;
  background: rgba(0, 0, 0, 0.55);
  border-right: 1px solid rgba(255,255,255,0.07);
  display: flex; flex-direction: column;
  transition: width 0.25s ease, min-width 0.25s ease;
  overflow: hidden;
  position: relative;
}
.sidebar--resizing { transition: none; }
.sidebar--collapsed { width: 60px !important; min-width: 60px !important; }

.sidebar__resize {
  position: absolute; top: 0; right: -3px; bottom: 0;
  width: 6px; cursor: col-resize; z-index: 20;
  background: transparent; transition: background 0.15s;
}
.sidebar__resize:hover,
.sidebar__resize:focus-visible,
.sidebar--resizing .sidebar__resize { background: var(--c-primary-bg, rgba(226,62,87,0.25)); }
.sidebar__resize:focus-visible { outline: none; }

.sidebar__brand {
  display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
  padding: 0.75rem 0.5rem 0.5rem;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.collapse-btn {
  color: rgba(255,255,255,0.35); background: none; border: none;
  cursor: pointer; padding: 0.2rem; border-radius: 0.3rem;
  transition: color 0.15s; flex-shrink: 0;
}
.collapse-btn:hover { color: rgba(255,255,255,0.7); }
.collapse-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 2px; }

/* Brand mark as the account/status button, with the backend-health dot. */
.brand-btn {
  position: relative; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; background: none; border: 0; border-radius: var(--radius-sm);
  cursor: pointer; line-height: 0;
}
.brand-btn--static { cursor: default; }
.brand-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 2px; }
.brand-dot {
  position: absolute; right: -3px; bottom: -3px;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--text-muted);
  border: 2px solid #0d0f14;
}
.brand-dot--online  { background: var(--c-success); }
.brand-dot--offline { background: var(--c-error); }

.add-btn {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.3rem 0.6rem; border-radius: var(--radius-sm);
  background: var(--c-primary-bg); border: 1px solid var(--c-primary-border);
  color: #ffd0d7; font-family: inherit; font-size: 0.78rem; font-weight: 600;
  white-space: nowrap; cursor: pointer; transition: background 0.15s, border-color 0.15s;
}
.add-btn:hover,
.add-btn--open { background: rgba(226,62,87,0.22); border-color: rgba(226,62,87,0.55); }
.add-btn:focus-visible { outline: 2px solid var(--brand-cream, #f7e7c8); outline-offset: 1px; }
.caret { opacity: 0.6; font-size: 0.6rem; }

.offline-banner {
  display: flex; align-items: center; gap: 0.45rem;
  margin: 0 0 0.5rem; padding: 0.4rem 0.6rem;
  border-radius: var(--radius-md);
  background: var(--c-error-bg); border: 1px solid var(--c-error-border);
  color: #ffd9cf; font-size: 0.78rem;
}

/* Account/status popover rows (teleported, but slot content keeps this
   component's scope, so these rules still reach it). */
.acct-row { display: flex; align-items: center; padding: 0.3rem 0.6rem; min-width: 0; }
.acct-row:empty { display: none; }
.acct-row--user {
  font-size: 0.8rem; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;
}

.nav-icon--upload {
  color: inherit;
  background: rgba(226,62,87,0.12);
  border-color: rgba(226,62,87,0.3);
}
.nav-icon--upload:hover { background: rgba(226,62,87,0.2); }

.sidebar__nav-icons { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.75rem 0.5rem; flex-shrink: 0; }
.nav-icon {
  width: 40px; height: 40px; border-radius: 0.5rem;
  display: flex; align-items: center; justify-content: center; font-size: 1.2rem;
  background: none; border: 1px solid transparent; color: inherit;
  font-family: inherit; cursor: pointer; transition: all 0.15s;
}
.nav-icon:hover { background: rgba(255,255,255,0.07); }
.nav-icon--active { background: var(--c-primary-bg); border-color: var(--c-primary-border); }

.sidebar__content { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0.75rem; }

.connection-status { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: rgba(255,255,255,0.4); }
.connection-dot   { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.25); }
.connection-status--online .connection-dot { background: var(--c-success); box-shadow: 0 0 6px rgba(242, 207, 122,0.7); }
.connection-status--offline .connection-dot { background: var(--c-error); }
.connection-status--online  { color: rgba(242, 207, 122,0.85); }
.connection-status--offline { color: rgba(251, 127, 92,0.85); }

/* Host settings dropdowns (backdrop visualizer + its audio source), in the
   Display popover. */
.host-select {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.6rem;
  font-size: 0.78rem; color: var(--text-secondary); width: 100%;
  min-width: 240px;
}
.host-select__label { flex: 0 0 4.5rem; }
.host-select__input {
  flex: 1; min-width: 0;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  color: rgba(255,255,255,0.85);
  font-size: 0.78rem; padding: 0.25rem 0.35rem; cursor: pointer;
}
.host-select__input:focus-visible { outline: 2px solid #f7e7c8; outline-offset: 1px; }
.host-select__input option { background: #12121c; color: #fff; }

.tools-dock {
  flex: 0 0 380px;
  max-width: 45vw;
  min-width: 0;
  overflow: hidden;
  display: flex;
}
.tools-dock > :deep(.tools) { flex: 1; min-width: 0; }
@media (max-width: 900px) {
  .tools-dock { flex-basis: 300px; }
}

.main {
  flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden;
  background: radial-gradient(ellipse at 50% 30%, rgba(226,62,87,0.10) 0%, transparent 60%);
}
.player-panel {
  flex-shrink: 0; height: 44px; padding: 0 0.75rem;
  background: rgba(0,0,0,0.4); border-bottom: 1px solid rgba(255,255,255,0.07);
  backdrop-filter: blur(16px); position: relative; z-index: 10;
  display: flex; align-items: center; gap: 0.4rem;
}
.player-panel > :deep(.player-bar) { flex: 1; min-width: 0; }
.popout-group { display: flex; gap: 0.3rem; flex-shrink: 0; }
.popout-btn {
  flex-shrink: 0;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.75);
  font-size: 0.75rem; font-weight: 600;
  padding: 0.35rem 0.7rem;
  border-radius: 0.4rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.popout-btn:hover:not(:disabled) {
  background: rgba(226,62,87,0.12);
  border-color: rgba(226,62,87,0.35);
  color: #e23e57;
}
.popout-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.popout-btn--icon {
  width: 30px; height: 30px;
  padding: 0;
  font-size: 1rem; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.popout-btn--active {
  background: rgba(226,62,87,0.15);
  border-color: rgba(226,62,87,0.45);
  color: #e23e57;
}

/* Floating variant: lives in .lyrics-area's .stage-tools cluster rather than
   the player panel. Held at low opacity so it doesn't compete with the lyrics
   preview, and lifted to full on hover/focus/active. z-index clears
   .screen-stage, which is an isolated stacking context at the auto level. */
.stage-tools {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 5;
  display: flex; align-items: center; gap: 0.35rem;
}
.popout-btn--display {
  height: 30px;
  display: inline-flex; align-items: center; gap: 0.3rem;
}
.popout-btn--float {
  /* This is now the ONLY affordance that opens the projector, so it has to
     stay findable in a dark venue — hence 0.65 rather than a true ghost. */
  opacity: 0.65;
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(4px);
}
.popout-btn--float:hover,
.popout-btn--float:focus-visible {
  opacity: 1;
}
.popout-btn--float:focus-visible {
  outline: 2px solid #f7e7c8;
  outline-offset: 2px;
}
/* Two classes so this outranks .popout-btn--float's background above and
   keeps the "projector is live" cue visible without hovering. The :hover
   variant is required as well: .popout-btn:hover:not(:disabled) scores
   (0,3,0) and would otherwise beat this rule, making an ACTIVE button go
   dimmer on hover — backwards from every other control here. */
.popout-btn--float.popout-btn--active,
.popout-btn--float.popout-btn--active:hover {
  opacity: 1;
  background: rgba(226,62,87,0.2);
  border-color: rgba(226,62,87,0.45);
  color: #e23e57;
}

/* Songless-pick notice: amber = "needs your attention", distinct from the
   blue action accents and the red offline state. Normal flow (flex-shrink: 0)
   so it only ever costs its own height, never overlays the lyrics. */
.pick-notice {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.5rem 0.35rem 0.75rem;
  background: rgba(251,191,36,0.09);
  border-bottom: 1px solid rgba(251,191,36,0.3);
  color: rgba(255,236,196,0.85);
  font-size: 0.8rem; line-height: 1.35;
}
.pick-notice__icon { flex-shrink: 0; font-size: 0.9rem; }
.pick-notice__text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.pick-notice__text strong { color: #fbbf24; font-weight: 700; }
.pick-notice__dismiss {
  flex-shrink: 0;
  width: 36px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: 1px solid transparent; border-radius: 0.4rem;
  color: rgba(255,236,196,0.55);
  font-family: inherit; font-size: 0.85rem; line-height: 1;
  cursor: pointer; transition: all 0.15s;
  /* Keeps the touch target 36px while the banner reads as a slim strip. */
  margin: -0.25rem 0;
}
.pick-notice__dismiss:hover {
  background: rgba(251,191,36,0.15);
  color: #fbbf24;
}
.pick-notice__dismiss:focus-visible {
  outline: 2px solid #fbbf24;
  outline-offset: 1px;
}

.content-split {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}

.lyrics-area {
  flex: 0 0 auto;
  min-height: 120px;
  overflow: hidden;
  display: flex; flex-direction: column; position: relative;
}
.lyrics-host { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }

.vsplit-handle {
  flex: 0 0 6px;
  position: relative;
  cursor: row-resize;
  background: rgba(255,255,255,0.04);
  border-top: 1px solid rgba(255,255,255,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
  z-index: 5;
}
.vsplit-handle:hover,
.vsplit-handle:focus-visible,
.app--resizing-y .vsplit-handle { background: var(--c-primary-bg, rgba(226,62,87,0.25)); }
.vsplit-handle:focus-visible { outline: none; }
.vsplit-grip {
  width: 36px; height: 2px; border-radius: 2px;
  background: rgba(255,255,255,0.25);
}
.vsplit-handle:hover .vsplit-grip,
.app--resizing-y .vsplit-grip { background: var(--c-primary, #e23e57); }

.queue-area {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 0.5rem;
  background: rgba(0,0,0,0.25);
  border-top: 1px solid rgba(255,255,255,0.04);
}

/* Hidden mount point for the popped-out lyrics instance. The wrapper stays
   display:none in the host page; the inner element is what gets moved into
   the popup window by useLyricsWindow. When the popup is open, the popup's
   document.body styles take over so the element fills the popup. */
.lyrics-popout-stage { display: none; }
.lyrics-popout-host {
  height: 100%; width: 100%;
  display: flex; flex-direction: column;
}

.welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 2rem; text-align: center; }
.welcome__logo  { filter: drop-shadow(0 0 30px rgba(226, 62, 87, 0.3)); margin-bottom: 0.5rem; }
.welcome__sub   { font-size: 1rem; color: rgba(255,255,255,0.4); max-width: 400px; }
.welcome__steps { display: flex; flex-direction: column; gap: 0.6rem; margin: 0.5rem 0; text-align: left; }
.welcome__step  { display: flex; align-items: center; gap: 0.75rem; font-size: 0.9rem; color: rgba(255,255,255,0.55); }
.step-num {
  width: 24px; height: 24px; border-radius: 50%;
  background: rgba(226,62,87,0.15); border: 1px solid rgba(226,62,87,0.3);
  color: var(--c-primary); font-size: 0.75rem; font-weight: 700;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.welcome__cta { margin-top: 0.5rem; padding: 0.7rem 1.75rem; font-size: 1rem; }

.upload-modal__title {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 1rem;
}
.upload-modal__title h2 {
  font-size: 1.05rem; font-weight: 700; color: white;
  letter-spacing: -0.01em; margin: 0;
}
.upload-modal__title .title-icon { display: flex; color: rgba(255,255,255,0.6); }

</style>
