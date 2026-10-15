// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The workbench toolbar says plainly whether edits are unsaved, and a failed
// save keeps them open with a retry instead of a one-line notice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const api = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { get: vi.fn(async () => ({ data: { stems: {} } })) },
  lyricsSetsApi: { create: (...a) => api.create(...a) },
}))

vi.mock('@/composables/useStemPlayer', async () => {
  const { ref } = await import('vue')
  return {
    useStemPlayer: () => ({
      buffer: ref(null), loading: ref(false), error: ref(null), playing: ref(false),
      loadUrl: vi.fn(async () => {}), unload: vi.fn(), monoSamples: vi.fn(() => null),
      play: vi.fn(), pause: vi.fn(), seek: vi.fn(), now: vi.fn(() => 0), setLoop: vi.fn(), dispose: vi.fn(),
    }),
  }
})

vi.mock('@/stage/KaraokeStage.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/editor/LineTimingLane.vue', () => ({ default: { render: () => null } }))

import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'

// Synthetic words only.
function syntheticDoc() {
  const line = (text, t0) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * 0.5, end: t0 + (i + 1) * 0.5 }))
  return { lines: [line('paper rivers fold', 5), line('lanterns drift slowly', 9), line('quiet harbor glass', 13)] }
}

let wrapper = null

function mountWorkbench() {
  wrapper = mount(EditorWorkbench, {
    props: { wordSync: syntheticDoc(), songId: 7, setId: 1, setLabel: 'Synthetic words', activeSetId: 1 },
  })
  return wrapper
}

const status = () => wrapper.find('.sv')
const mergeUp = async () => {
  await wrapper.findAll('.ll-action')[0].trigger('click')
  await flushPromises()
}
const saveButton = () => wrapper.findAll('button').find((b) => b.text() === 'Save as new set and make active')

beforeEach(() => {
  api.create.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('EditorWorkbench save status', () => {
  it('shows clean, unsaved and back-to-clean as edits are made and undone', async () => {
    mountWorkbench()
    expect(status().text()).toBe('No unsaved changes')
    expect(status().attributes('aria-live')).toBe('polite')
    expect(wrapper.text()).not.toContain(' ops')

    await mergeUp()
    expect(status().text()).toBe('Unsaved changes · 1 change')
    await mergeUp()
    expect(status().text()).toBe('Unsaved changes · 2 changes')
    expect(wrapper.vm.dirty).toBe(true)

    const undo = wrapper.findAll('button').find((b) => b.text() === '⟲ Undo')
    await undo.trigger('click')
    await undo.trigger('click')
    expect(status().text()).toBe('No unsaved changes')
    expect(wrapper.vm.dirty).toBe(false)
  })

  it('labels Save as what it does', async () => {
    mountWorkbench()
    await mergeUp()
    const save = saveButton()
    expect(save).toBeTruthy()
    expect(save.attributes('title')).toBe(
      'Creates a new lyrics set from your edits and makes it the lyrics used for performances. Set #1 is kept unchanged.',
    )
  })

  it('a failed save keeps the edits, says nothing changed, and offers a retry', async () => {
    api.create.mockRejectedValueOnce(new Error('the local service did not respond'))
    mountWorkbench()
    await mergeUp()
    const result = await wrapper.vm.save()
    await flushPromises()
    expect(result).toBeNull()
    expect(status().text()).toBe('Unsaved — last save failed')
    const alert = wrapper.find('[role="alert"]')
    expect(alert.text()).toContain('Save failed — nothing was changed.')
    expect(alert.text()).toContain('The active set is still #1, and your 1 change is still open here.')
    expect(alert.text()).toContain('Reason: the local service did not respond.')
    expect(wrapper.emitted('saved')).toBeUndefined()

    api.create.mockResolvedValueOnce({ data: { id: 5, label: 'edited from Synthetic words' } })
    const retry = wrapper.findAll('button').find((b) => b.text() === 'Retry save')
    await retry.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.emitted('saved')[0][0]).toEqual({ id: 5, label: 'edited from Synthetic words' })
  })
})
