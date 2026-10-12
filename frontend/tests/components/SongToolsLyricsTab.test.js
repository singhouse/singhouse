// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The Lyrics tab's anchor choice, and the two actions it governs.
//
// The old modal asked "which reference_mode" and left the user to know what
// each did to the request; this asks what the words should be anchored to and
// derives the mode. What has to hold is the mapping (an anchor the user picked
// must reach the server as the mode that means it), the rule that lyrics never
// travel with `none` (the server 400s that, deliberately, so they are never
// silently discarded), and every pre-guard that exists so a host reads a
// reason instead of a 409.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'

const api = vi.hoisted(() => ({
  featuresGet: vi.fn(),
  cacheStatus: vi.fn(),
  realign: vi.fn(),
  transcribe: vi.fn(),
  page: vi.fn(),
  getSet: vi.fn(),
  pollJob: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  featuresApi: { get: (...a) => api.featuresGet(...a) },
  songApi: { get: vi.fn(async () => ({ data: {} })), pollJob: (...a) => api.pollJob(...a) },
  lyricsSetsApi: {
    list: vi.fn(async () => ({ data: [] })),
    get: (...a) => api.getSet(...a),
    cacheStatus: (...a) => api.cacheStatus(...a),
    realign: (...a) => api.realign(...a),
    transcribe: (...a) => api.transcribe(...a),
    page: (...a) => api.page(...a),
    copy: vi.fn(async () => ({ data: {} })),
  },
}))

import LyricsTab from '@/components/songtools/LyricsTab.vue'

const READY = { id: 1, status: 'ready', artist: 'Bowie', title: 'Heroes' }

function set(overrides = {}) {
  return {
    id: 10,
    source: 'manual',
    label: 'pasted',
    is_active: true,
    is_verified: false,
    has_word_sync: true,
    has_plain_lyrics: true,
    has_synced_lyrics: false,
    created_at: '2026-08-01T10:00:00',
    ...overrides,
  }
}

function flags(enabled) {
  return {
    data: { llm_paging: true, lyrics_lookup: { enabled, provider: 'lrclib', label: 'lrclib.net' } },
  }
}

async function mountTab({ sets = [set()], song = READY, cache = true } = {}) {
  api.cacheStatus.mockResolvedValue({ data: { exists: cache, label: 'heart+vad' } })
  const wrapper = mount(LyricsTab, {
    props: { songId: 1, song, sets },
  })
  await flushPromises()
  return wrapper
}

function anchors(wrapper) {
  return wrapper.vm.anchorOptions.map(o => o.value)
}

/** Pick an anchor through the radio the user would click. */
async function chooseAnchor(wrapper, value) {
  const index = wrapper.vm.anchorOptions.findIndex(o => o.value === value)
  await wrapper.findAll('input[name="anchor"]')[index].trigger('change')
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  api.featuresGet.mockResolvedValue(flags(false))
  api.getSet.mockResolvedValue({ data: { plain_lyrics: 'one\ntwo\nthree\n' } })
  api.realign.mockResolvedValue({ data: { job_id: 'j1' } })
  api.transcribe.mockResolvedValue({ data: { job_id: 'j2' } })
  api.pollJob.mockResolvedValue({ data: { status: 'running' } })
})

describe('the anchor choice', () => {
  it('offers nothing / this song / paste, and never `auto`', async () => {
    // `auto` resolved its reference server-side, so what it actually anchored
    // to could not be named here. An anchor nobody can name is the thing this
    // panel exists to remove.
    const w = await mountTab()
    expect(anchors(w)).toEqual(['none', 'active', 'paste'])
    expect(anchors(w)).not.toContain('auto')
  })

  it('withholds the lookup anchor until the operator has opted in', async () => {
    const off = await mountTab()
    expect(anchors(off)).not.toContain('lrclib')

    api.featuresGet.mockResolvedValue(flags(true))
    setActivePinia(createPinia())
    const on = await mountTab()
    expect(anchors(on)).toContain('lrclib')
  })

  it('never names a vendor the server has not named', async () => {
    // The visible copy takes the label the server sent, and falls back to the
    // features store's neutral wording rather than to `lrclib` — this panel
    // must not tell a host which service it is about to ask when the server
    // did not say.
    api.featuresGet.mockResolvedValue({ data: { llm_paging: true, lyrics_lookup: { enabled: true } } })
    const w = await mountTab()
    const lookup = w.vm.anchorOptions.find(o => o.value === 'lrclib')

    expect(lookup.label).toBe('Look up on a third-party service')
    expect(w.text()).not.toContain('lrclib')
  })

  it('defaults to nothing, so a stock run submits no reference', async () => {
    const w = await mountTab()
    expect(w.vm.anchor).toBe('none')
    expect(w.vm.buildBody()).toMatchObject({ reference_mode: 'none' })
  })

  it('defaults to plain lookup when enabled capabilities arrive', async () => {
    api.featuresGet.mockResolvedValue(flags(true))
    const w = await mountTab()
    expect(w.vm.buildBody().reference_mode).toBe('lrclib')
    expect(w.text()).toContain('plain lyrics')
  })

  it.each(['none', 'paste', 'active'])('preserves an explicit %s choice during capability loading', async choice => {
    let resolve
    api.featuresGet.mockReturnValue(new Promise(r => { resolve = r }))
    const w = await mountTab()
    await chooseAnchor(w, choice)
    if (choice === 'paste') await w.find('textarea').setValue('My correct lyrics')
    resolve(flags(true))
    await flushPromises()
    expect(w.vm.buildBody().reference_mode).toBe(choice)
    if (choice === 'paste') expect(w.vm.buildBody().plain_lyrics).toBe('My correct lyrics')
  })

  it('names the saved lyrics with their line count', async () => {
    const w = await mountTab()
    const active = w.vm.anchorOptions.find(o => o.value === 'active')
    expect(active.label).toBe('Lyrics saved on this song (3 lines)')
  })
})

describe('anchoring to the lyrics saved on the song', () => {
  it('is greyed out, with the reason, when the active set is a transcription', async () => {
    // The server 409s this: anchoring to a transcription feeds the speech
    // model its own output back in.
    const w = await mountTab({ sets: [set({ source: 'transcription' })] })
    const active = w.vm.anchorOptions.find(o => o.value === 'active')

    expect(active.disabled).toBe(true)
    expect(active.reason).toMatch(/own output back in/)
    expect(w.findAll('input[name="anchor"]')[1].attributes('disabled')).toBeDefined()
  })

  it('is greyed out when the song has no active set at all', async () => {
    const w = await mountTab({ sets: [set({ is_active: false })] })
    const active = w.vm.anchorOptions.find(o => o.value === 'active')
    expect(active.disabled).toBe(true)
    expect(active.reason).toMatch(/no active lyrics set/)
  })

  it('falls back to nothing when the selection stops being available', async () => {
    const w = await mountTab()
    await chooseAnchor(w, 'active')
    expect(w.vm.anchor).toBe('active')

    // The active set is replaced by a fresh transcription while the panel sits
    // open — submitting `active` now would be a 409.
    await w.setProps({ sets: [set({ source: 'transcription' })] })
    await flushPromises()

    expect(w.vm.anchor).toBe('none')
  })


  it('maps to reference_mode=active and sends no lyrics of its own', async () => {
    const w = await mountTab()
    await chooseAnchor(w, 'active')

    const body = w.vm.buildBody()
    expect(body.reference_mode).toBe('active')
    expect(body.plain_lyrics).toBeUndefined()
    expect(body.synced_lyrics).toBeUndefined()
  })
})

describe('pasted lyrics', () => {
  it('travel as plain_lyrics under reference_mode=paste', async () => {
    const w = await mountTab()
    await chooseAnchor(w, 'paste')
    await w.find('textarea').setValue('first line\nsecond line\n')

    const body = w.vm.buildBody()
    expect(body.reference_mode).toBe('paste')
    expect(body.plain_lyrics).toBe('first line\nsecond line')
    expect(body.synced_lyrics).toBeUndefined()
  })

  it('travel as synced_lyrics when they are LRC, and say so', async () => {
    const w = await mountTab()
    await chooseAnchor(w, 'paste')
    await w.find('textarea').setValue('[00:12.34] first\n[00:15.00] second\n')

    const body = w.vm.buildBody()
    expect(body.synced_lyrics).toContain('[00:12.34]')
    expect(body.plain_lyrics).toBeUndefined()
    expect(w.text()).toContain('LRC detected')
    expect(w.text()).toMatch(/timestamps will be used as anchors/)
  })

  it('block both actions while the box is empty', async () => {
    const w = await mountTab()
    await chooseAnchor(w, 'paste')
    expect(w.vm.refitBlocked).toMatch(/Paste the lyrics/)
    expect(w.vm.listenBlocked).toMatch(/Paste the lyrics/)
  })

  it('are never sent with the `nothing` anchor', async () => {
    // The server 400s lyrics under reference_mode=none precisely so they are
    // not silently discarded — so the client never builds that body.
    const w = await mountTab()
    await chooseAnchor(w, 'paste')
    await w.find('textarea').setValue('some words')
    await chooseAnchor(w, 'none')

    const body = w.vm.buildBody()
    expect(body.reference_mode).toBe('none')
    expect(body.plain_lyrics).toBeUndefined()
    expect(body.synced_lyrics).toBeUndefined()
  })
})

describe('the two action cards', () => {
  it('makes Re-fit the primary when a cached transcription exists', async () => {
    const w = await mountTab({ cache: true })
    expect(w.vm.refitBlocked).toBe('')
    const cards = w.findAll('.card')
    expect(cards[0].classes()).toContain('card--primary')
    expect(cards[1].classes()).not.toContain('card--primary')
  })

  it('disables Re-fit with the model named when nothing is cached', async () => {
    // This is also the state right after a re-split: the vocals the cached
    // transcription was made from have been replaced.
    const w = await mountTab({ cache: false })
    expect(w.vm.refitBlocked).toBe(
      'No transcription cached for heart — run Listen again first.'
    )
    expect(w.findAll('.card')[1].classes()).toContain('card--primary')
    expect(w.findAll('.card__go')[0].attributes('disabled')).toBeDefined()
    // Listening again is exactly what the reason tells them to do, so it must
    // not be blocked too.
    expect(w.vm.listenBlocked).toBe('')
  })

  it('re-probes the cache when the model changes', async () => {
    const w = await mountTab({ cache: true })
    api.cacheStatus.mockResolvedValue({ data: { exists: false, label: 'small+vad' } })

    await w.find('select').setValue('small')
    await flushPromises()

    expect(api.cacheStatus).toHaveBeenLastCalledWith(1, { model: 'small', useVad: true })
    expect(w.vm.refitBlocked).toMatch(/No transcription cached for small/)
  })

  it('ignores a cache answer a later probe has already superseded', async () => {
    // Two probes in flight, answered out of order. The slow reply belongs to a
    // model the host has already moved off; letting it land would say "cached"
    // about the wrong one, and Re-fit is offered or refused on exactly that.
    const pending = []
    api.cacheStatus.mockImplementation(() => new Promise(resolve => pending.push(resolve)))

    const w = mount(LyricsTab, { props: { songId: 1, song: READY, sets: [set()] } })
    await flushPromises()
    pending[0]({ data: { exists: false, label: '' } })   // the mount probe
    await flushPromises()

    await w.find('select').setValue('small')            // probe 2 — slow
    await flushPromises()
    await w.find('select').setValue('tiny')             // probe 3 — fast
    await flushPromises()
    expect(pending.length).toBe(3)

    pending[2]({ data: { exists: true, label: 'tiny+vad' } })
    await flushPromises()
    pending[1]({ data: { exists: false, label: 'small+vad' } })
    await flushPromises()

    expect(w.vm.cacheReady).toBe(true)
    expect(w.vm.refitBlocked).toBe('')
  })

  it('sends the re-fit to /realign and the listen to /transcribe', async () => {
    const w = await mountTab()
    await w.findAll('.card__go')[0].trigger('click')
    await flushPromises()
    expect(api.realign).toHaveBeenCalledWith(1, expect.objectContaining({
      whisper_model: 'heart', use_vad: true, reference_mode: 'none', activate: true,
    }))

    setActivePinia(createPinia())
    const w2 = await mountTab()
    await w2.findAll('.card__go')[1].trigger('click')
    await flushPromises()
    expect(api.transcribe).toHaveBeenCalledWith(1, expect.objectContaining({
      whisper_model: 'heart', reference_mode: 'none', activate: true,
    }))
  })

  it('sends paging only when ticked and configured', async () => {
    const w = await mountTab()
    // Paging is explicitly selected on each card.
    await w.findAll('.card')[0].find('input[type="checkbox"]').setValue(true)
    expect(w.vm.buildBody({ paging: true })).toMatchObject({ llm_paging: true })
    expect(w.vm.buildBody()).not.toHaveProperty('llm_paging')
    expect(w.vm.buildBody()).not.toHaveProperty('llm_correction')
  })


  it('blocks both actions while a job is already running for this song', async () => {
    const w = await mountTab()
    await w.findAll('.card__go')[0].trigger('click')
    await flushPromises()

    expect(w.vm.refitBlocked).toMatch(/already running/)
    expect(w.vm.listenBlocked).toMatch(/already running/)
  })

  it('blocks both actions on a song that is not ready', async () => {
    const w = await mountTab({ song: { id: 1, status: 'failed' } })
    expect(w.vm.refitBlocked).toMatch(/ingest failed/)
    expect(w.vm.listenBlocked).toMatch(/ingest failed/)
  })
})


describe('optional paging capability', () => {
  it('hides paging controls and drops paging requests when unconfigured', async () => {
    api.featuresGet.mockResolvedValue({ data: { llm_paging: false } })
    const w = await mountTab()
    expect(w.text()).not.toContain('LLM paging')
    expect(w.text()).not.toContain('LLM correction')
    expect(w.vm.buildBody({ paging: true })).not.toHaveProperty('llm_paging')
  })

  it('shows paging controls when configured', async () => {
    const w = await mountTab()
    expect(w.text()).toContain('LLM paging')
    expect(w.text()).not.toContain('LLM correction')
    expect(w.vm.buildBody({ paging: true }).llm_paging).toBe(true)
  })
})
