// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The lyrics editor never silently drops unsaved edits: leaving, switching
// sets, duplicating and closing the desktop window all ask Save / Discard /
// Keep editing while the session has edits, and stay instant when it has none.
// The workbench is replaced by a small stand-in that runs the real editor
// session, so "unsaved" is the session's own op log.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

const api = vi.hoisted(() => ({
  getSong: vi.fn(),
  listSets: vi.fn(),
  getSet: vi.fn(),
  copy: vi.fn(),
}))

// Shared with the workbench stand-in: the live session and the save outcome.
const wb = vi.hoisted(() => ({ session: null, saveImpl: null, exported: 0 }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { get: (...a) => api.getSong(...a) },
  lyricsSetsApi: {
    list: (...a) => api.listSets(...a),
    get: (...a) => api.getSet(...a),
    copy: (...a) => api.copy(...a),
  },
}))

vi.mock('@/components/SongToolsPanel.vue', () => ({ default: { render: () => null } }))

vi.mock('@/components/editor/EditorWorkbench.vue', async () => {
  const { defineComponent, h, watch } = await import('vue')
  const { useEditorSession } = await import('@/composables/useEditorSession')
  return {
    default: defineComponent({
      name: 'EditorWorkbenchStub',
      props: {
        wordSync: { type: Object, required: true },
        songId: { type: Number, default: null },
        setId: { type: Number, default: null },
        setLabel: { type: String, default: '' },
        activeSetId: { type: Number, default: null },
      },
      emits: ['saved'],
      setup(props, { emit, expose }) {
        const session = useEditorSession()
        watch(() => props.wordSync, (ws) => session.load(ws), { immediate: true })
        wb.session = session
        async function save() {
          const created = await session.trackSave(() => wb.saveImpl())
          if (created) emit('saved', created)
          return created
        }
        expose({
          dirty: session.dirty,
          opCount: session.opCount,
          saveState: session.saveState,
          saveError: session.saveError,
          validation: session.validation,
          save,
          saveSessionFile: () => { wb.exported++ },
        })
        return () => h('div', { class: 'wb-stub' }, `${session.opCount.value} edits`)
      },
    }),
  }
})

import LyricsEditorView from '@/views/LyricsEditorView.vue'
import { BRAND_NAME } from '@/brand.js'

// Synthetic words only.
function syntheticDoc() {
  const line = (text, t0) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * 0.5, end: t0 + (i + 1) * 0.5 }))
  return { lines: [line('paper rivers fold', 5), line('lanterns drift slowly', 9), line('quiet harbor glass', 13)] }
}

const SETS = [
  { id: 1, source: 'manual', label: 'Synthetic words', is_active: true, has_word_sync: true },
  { id: 2, source: 'manual', label: 'Earlier pass', is_active: false, has_word_sync: true },
]

const MERGE = { type: 'mergeLines', lineIdx: 0 }

let wrapper = null
let router = null

async function mountEditor(path = '/songs/7/lyrics-editor/1') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'host', component: { render: () => null } },
      { path: '/songs/:songId(\\d+)/lyrics-editor/:setId(\\d+)?', name: 'lyrics-editor', component: LyricsEditorView },
    ],
  })
  router.push(path)
  await router.isReady()
  wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const dialog = () => document.body.querySelector('[role="dialog"]')
const button = (label) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim() === label)

async function click(label) {
  const b = button(label)
  expect(b, `button "${label}"`).toBeTruthy()
  b.click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  api.getSong.mockResolvedValue({ data: { id: 7, artist: 'Unknown Artist', title: 'Paper Rivers', stems: {} } })
  api.listSets.mockImplementation(async () => ({ data: SETS.map((s) => ({ ...s })) }))
  api.getSet.mockImplementation(async (_song, lid) => {
    const ls = SETS.find((s) => s.id === lid) ?? { id: lid, source: 'manual', label: `set ${lid}` }
    return { data: { ...ls, word_sync: syntheticDoc() } }
  })
  api.copy.mockResolvedValue({ data: { id: 9, label: 'copy of Synthetic words' } })
  wb.saveImpl = vi.fn(async () => ({ id: 5, label: 'edited from Synthetic words' }))
  wb.exported = 0
  delete window.karaokeDesktop
  document.title = BRAND_NAME
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  delete window.karaokeDesktop
})

describe('lyrics editor unsaved-edits guard', () => {
  it('leaving with no edits does not prompt', async () => {
    await mountEditor()
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('host')
    expect(dialog()).toBeNull()
  })

  it('shows the unsaved status in the window title while edits are pending', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    await flushPromises()
    expect(document.title).toBe(`● ${BRAND_NAME}`)
    wb.session.undo()
    await flushPromises()
    expect(document.title).toBe(BRAND_NAME)
  })

  it('leaving with edits prompts, and Discard proceeds', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/')
    await flushPromises()
    expect(dialog()?.textContent).toContain('Leave with unsaved lyric edits?')
    expect(dialog().textContent).toContain('You have 1 change not yet saved in set #1 manual · Synthetic words.')
    expect(document.activeElement?.textContent.trim()).toBe('Keep editing')
    await click('Discard edits')
    await nav
    expect(router.currentRoute.value.name).toBe('host')
    expect(wb.saveImpl).not.toHaveBeenCalled()
  })

  it('Keep editing cancels the leave and keeps the edits', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/')
    await flushPromises()
    await click('Keep editing')
    await nav
    expect(router.currentRoute.value.name).toBe('lyrics-editor')
    expect(dialog()).toBeNull()
    expect(wb.session.opCount.value).toBe(1)
  })

  it('Escape means Keep editing', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nav
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('lyrics-editor')
    expect(dialog()).toBeNull()
  })

  it('Save saves the edits and then continues the leave', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/')
    await flushPromises()
    await click('Save as new set and make active')
    await nav
    expect(wb.saveImpl).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.name).toBe('host')
  })

  it('a failed save keeps the edits and does not leave', async () => {
    wb.saveImpl = vi.fn(async () => { throw new Error('the local service did not respond') })
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/')
    await flushPromises()
    await click('Save as new set and make active')
    expect(router.currentRoute.value.name).toBe('lyrics-editor')
    expect(dialog().textContent).toContain('Couldn’t save your lyric edits')
    expect(dialog().textContent).toContain('Reason: the local service did not respond.')
    expect(dialog().textContent).toContain('the active set is still #1')
    expect(button('Retry save')).toBeTruthy()
    expect(wb.session.opCount.value).toBe(1)
    expect(wb.session.saveState.value).toBe('failed')

    await click('export the session file')
    expect(wb.exported).toBe(1)

    await click('Keep editing')
    await nav
    expect(router.currentRoute.value.name).toBe('lyrics-editor')
    expect(wb.session.opCount.value).toBe(1)
  })

  it('undoing back to zero edits leaves without a prompt', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    wb.session.undo()
    await flushPromises()
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('host')
    expect(dialog()).toBeNull()
  })

  it('Keep editing on a set switch restores the selector and keeps the set', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    await flushPromises()
    const select = wrapper.find('select.ed-select')
    await select.setValue('2')
    await flushPromises()
    expect(dialog()?.textContent).toContain('Switch sets with unsaved lyric edits?')
    expect(dialog().textContent).toContain('Opening set #2 now would discard it.')
    await click('Keep editing')
    expect(select.element.value).toBe('1')
    expect(api.getSet).not.toHaveBeenCalledWith(7, 2)
    expect(wb.session.opCount.value).toBe(1)
  })

  it('Discard on a set switch opens the other set', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    await flushPromises()
    await wrapper.find('select.ed-select').setValue('2')
    await flushPromises()
    await click('Discard edits')
    expect(api.getSet).toHaveBeenCalledWith(7, 2)
    expect(router.currentRoute.value.params.setId).toBe('2')
    expect(wb.session.opCount.value).toBe(0)
    expect(wrapper.text()).toContain('Discarded 1 change to set #1; it is unchanged.')
  })

  it('a switch with no edits does not prompt', async () => {
    await mountEditor()
    await wrapper.find('select.ed-select').setValue('2')
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(router.currentRoute.value.params.setId).toBe('2')
  })

  it('history navigation to another set prompts', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    const nav = router.push('/songs/7/lyrics-editor/2')
    await flushPromises()
    expect(dialog()?.textContent).toContain('Switch sets with unsaved lyric edits?')
    await click('Keep editing')
    await nav
    expect(router.currentRoute.value.params.setId).toBe('1')
  })

  it('Duplicate with edits prompts first', async () => {
    await mountEditor()
    wb.session.apply(MERGE)
    await flushPromises()
    await click('⧉ Duplicate set')
    expect(dialog()?.textContent).toContain('Duplicate without your unsaved edits?')
    await click('Keep editing')
    expect(api.copy).not.toHaveBeenCalled()

    await click('⧉ Duplicate set')
    await click('Discard edits')
    expect(api.copy).toHaveBeenCalledWith(7, 1)
    expect(router.currentRoute.value.params.setId).toBe('9')
  })

  describe('desktop window close', () => {
    function installDesktop() {
      const desktop = {
        setCloseGuard: vi.fn(async () => {}),
        answerCloseRequest: vi.fn(async () => true),
        onCloseRequested: vi.fn((cb) => { desktop.request = cb; return () => { desktop.request = null } }),
        request: null,
      }
      window.karaokeDesktop = desktop
      return desktop
    }

    it('arms the host guard only while edits are unsaved', async () => {
      const desktop = installDesktop()
      await mountEditor()
      expect(desktop.onCloseRequested).toHaveBeenCalledTimes(1)
      wb.session.apply(MERGE)
      await flushPromises()
      expect(desktop.setCloseGuard).toHaveBeenLastCalledWith(true)
      wb.session.undo()
      await flushPromises()
      expect(desktop.setCloseGuard).toHaveBeenLastCalledWith(false)
    })

    it('a close request with edits shows the in-app prompt and answers it', async () => {
      const desktop = installDesktop()
      await mountEditor()
      wb.session.apply(MERGE)
      await flushPromises()

      const answered = desktop.request()
      await flushPromises()
      expect(dialog()?.textContent).toContain(`Close ${BRAND_NAME} with unsaved lyric edits?`)
      expect(desktop.answerCloseRequest).not.toHaveBeenCalled()
      await click('Keep editing')
      await answered
      expect(desktop.answerCloseRequest).toHaveBeenLastCalledWith('cancel')

      const again = desktop.request()
      await flushPromises()
      await click('Discard edits')
      await again
      expect(desktop.answerCloseRequest).toHaveBeenLastCalledWith('proceed')
    })

    it('a close request with no edits proceeds without a prompt', async () => {
      const desktop = installDesktop()
      await mountEditor()
      await desktop.request()
      expect(dialog()).toBeNull()
      expect(desktop.answerCloseRequest).toHaveBeenCalledWith('proceed')
    })
  })
})
