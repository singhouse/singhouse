// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Contract test for core SongList's neutral 'library-menu' seam and the ⋯
// menu that hosts it. An installed package may register an ARRAY of items
// ({ id, label, icon?, title?, size?, component, visible? }); core lists the
// visible ones under its own entries and mounts the picked item's component
// in a core Modal. With nothing registered, the menu is core's alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'

const listSongs = vi.fn()

vi.mock('@/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  songApi: { list: (...a) => listSongs(...a) },
}))

const reg = vi.hoisted(() => ({ items: null }))
vi.mock('@/plugins/slots', () => ({
  getSlot: (name) => (name === 'library-menu' ? reg.items : null),
  registerSlot: vi.fn(),
  slotHasContent: (name) => name === 'library-menu' && !!reg.items,
}))

import SongList from '@/components/SongList.vue'

const shown = ref(true)
const ItemBody = { template: '<div class="item-body">item body</div>' }

let wrapper = null

function mountList() {
  wrapper = mount(SongList, { global: { stubs: { teleport: true } } })
  return wrapper
}

async function openMenu() {
  await wrapper.find('.lib-menu__btn').trigger('click')
}

const menuLabels = () => wrapper.findAll('[role="menuitem"]').map(b => b.text())

beforeEach(() => {
  setActivePinia(createPinia())
  listSongs.mockReset()
  listSongs.mockResolvedValue({ data: { songs: [] } })
  shown.value = true
  reg.items = null
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('the library ⋯ menu', () => {
  it('offers only Refresh and Columns when nothing is registered', async () => {
    mountList()
    await openMenu()
    expect(menuLabels().map(t => t.replace(/^\W+/, ''))).toEqual(['Refresh library', 'Columns…'])
    expect(wrapper.find('.ui-menu__sep').exists()).toBe(false)
  })

  it('Refresh refetches the library and closes the menu', async () => {
    mountList()
    await openMenu()
    listSongs.mockClear()
    await wrapper.findAll('[role="menuitem"]')[0].trigger('click')
    expect(listSongs).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('Columns… swaps to the chooser and focuses its first changeable box', async () => {
    wrapper = mount(SongList, { global: { stubs: { teleport: true } }, attachTo: document.body })
    await openMenu()
    await wrapper.find('.lib-menu__columns').trigger('click')
    await nextTick()
    const boxes = wrapper.findAll('.col-menu__pop input[type="checkbox"]')
    const first = boxes.find(b => !b.element.disabled)
    expect(first).toBeTruthy()
    expect(document.activeElement).toBe(first.element)
  })

  it('marks its trigger as a menu button', async () => {
    mountList()
    const btn = wrapper.find('.lib-menu__btn')
    expect(btn.attributes('aria-haspopup')).toBe('menu')
    expect(btn.attributes('aria-expanded')).toBe('false')
    await openMenu()
    expect(btn.attributes('aria-expanded')).toBe('true')
  })
})

describe("the 'library-menu' seam", () => {
  beforeEach(() => {
    reg.items = [
      { id: 'a', label: 'Thing A…', icon: '★', title: 'Thing A', component: ItemBody, visible: () => shown.value },
      { id: 'b', label: 'Thing B…', component: ItemBody },
    ]
  })

  it('lists registered items after a divider', async () => {
    mountList()
    await openMenu()
    const labels = menuLabels()
    expect(labels.some(t => t.includes('Thing A…'))).toBe(true)
    expect(labels.some(t => t.includes('Thing B…'))).toBe(true)
    expect(wrapper.find('.ui-menu__sep').exists()).toBe(true)
  })

  it('honours visible() at render time', async () => {
    shown.value = false
    mountList()
    await openMenu()
    expect(menuLabels().some(t => t.includes('Thing A…'))).toBe(false)
    expect(menuLabels().some(t => t.includes('Thing B…'))).toBe(true)
  })

  it('mounts the picked item in a modal, with its title, only once picked', async () => {
    mountList()
    expect(wrapper.find('.item-body').exists()).toBe(false)
    await openMenu()
    await wrapper.findAll('[role="menuitem"]').find(b => b.text().includes('Thing A…')).trigger('click')

    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(wrapper.find('.item-body').exists()).toBe(true)
    expect(wrapper.find('.lib-item-modal__title').text()).toBe('Thing A')
  })
})
