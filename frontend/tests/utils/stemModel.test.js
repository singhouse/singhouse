// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest'
import { buildStemModel, MAX_VOCAL_LANES } from '@/utils/stemModel.js'
import { colorForVoiceId } from '@/utils/voiceLayout.js'

describe('buildStemModel — standard 2-stem song', () => {
  const stems = {
    instrumental: 'blob:inst',
    vocals: [
      { id: 'lead', name: null, url: 'blob:lead' },
      { id: 'backing', name: null, url: 'blob:backing' },
    ],
  }

  it('orders lanes [lead, backing, instrumental-last] with those keys', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.map((l) => l.key)).toEqual(['lead', 'backing', 'instrumental'])
    expect(lanes.map((l) => l.kind)).toEqual(['vocal', 'vocal', 'instrumental'])
  })

  it('uses the generalized default mix (inst 1, lead 0, backing 0.7)', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.map((l) => l.volume)).toEqual([0, 0.7, 1])
  })

  it('labels the well-known lanes', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.map((l) => l.label)).toEqual(['Lead Vocals', 'Backing Vocals', 'Instrumental'])
  })

  it('gives lead and backing different colors', () => {
    const lanes = buildStemModel(stems)
    const lead = lanes.find((l) => l.key === 'lead')
    const backing = lanes.find((l) => l.key === 'backing')
    expect(lead.color).not.toBe(backing.color)
  })
})

describe('buildStemModel — named multi-voice song', () => {
  const stems = {
    instrumental: 'blob:inst',
    vocals: [
      { id: '6', name: 'Bob', url: 'blob:6' },
      { id: '7', name: 'Jerry', url: 'blob:7' },
    ],
  }
  const roster = ['6', '7']

  it('uses the roster names as lane labels', () => {
    const lanes = buildStemModel(stems, roster)
    expect(lanes.map((l) => l.label)).toEqual(['Bob', 'Jerry', 'Instrumental'])
  })

  it('matches each vocal lane color to the stage color for its voice', () => {
    const lanes = buildStemModel(stems, roster)
    const bob = lanes.find((l) => l.key === '6')
    const jerry = lanes.find((l) => l.key === '7')
    expect(bob.color).toBe(colorForVoiceId('6', roster).activeColor)
    expect(jerry.color).toBe(colorForVoiceId('7', roster).activeColor)
  })
})

describe('buildStemModel — numbered generic lanes', () => {
  const stems = {
    instrumental: 'blob:inst',
    vocals: [
      { id: 'lead', name: null, url: 'blob:lead' },
      { id: 'lead_2', name: null, url: 'blob:lead2' },
      { id: 'backing', name: null, url: 'blob:backing' },
      { id: 'backing_3', name: null, url: 'blob:backing3' },
    ],
  }

  it('labels numbered generics off their base label', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.map((l) => l.label)).toEqual([
      'Lead Vocals', 'Lead Vocals 2', 'Backing Vocals', 'Backing Vocals 3', 'Instrumental',
    ])
  })

  it('opens every backing lane at the backing default, numbered or not', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.map((l) => l.volume)).toEqual([0, 0, 0.7, 0.7, 1])
  })

  it('gives numbered lanes no icon, so the mixer shows their color dot', () => {
    const lanes = buildStemModel(stems)
    expect(lanes.find((l) => l.key === 'lead_2').icon).toBe('')
    expect(lanes.find((l) => l.key === 'backing_3').icon).toBe('')
    expect(lanes.find((l) => l.key === 'lead').icon).not.toBe('')
  })

  it('still prefers a name the backend supplied', () => {
    const lanes = buildStemModel({ vocals: [{ id: 'backing_2', name: 'The Choir', url: 'blob:c' }] })
    expect(lanes[0].label).toBe('The Choir')
  })
})

describe('buildStemModel — compound lanes (several voices in one file)', () => {
  const roster = ['7', '8', '9']

  it('uses the name the backend pre-joined', () => {
    const lanes = buildStemModel({ vocals: [{ id: '7+8', name: 'Alto & Tenor', url: 'blob:78' }] }, roster)
    expect(lanes[0].label).toBe('Alto & Tenor')
  })

  it('falls back to the bare compound id when unnamed', () => {
    const lanes = buildStemModel({ vocals: [{ id: '7+8', name: null, url: 'blob:78' }] }, roster)
    expect(lanes[0].label).toBe('Voice 7+8')
  })

  it('stays a muted guide by default', () => {
    const lanes = buildStemModel({ vocals: [{ id: '7+8', url: 'blob:78' }] }, roster)
    expect(lanes[0].volume).toBe(0)
  })

  it('carries the stage color of its first rostered constituent', () => {
    const lanes = buildStemModel({ vocals: [{ id: '7+8', url: 'blob:78' }] }, roster)
    expect(lanes[0].color).toBe(colorForVoiceId('7', roster).activeColor)
    expect(lanes[0].color).not.toBe(colorForVoiceId('9', roster).activeColor)
  })

  it('still gets a color with no roster at all', () => {
    const lanes = buildStemModel({ vocals: [{ id: '7+8', url: 'blob:78' }] }, [])
    expect(typeof lanes[0].color).toBe('string')
    expect(lanes[0].color).not.toBe('')
  })
})

describe('buildStemModel — edge cases', () => {
  it('returns [] for empty or missing stems', () => {
    expect(buildStemModel({})).toEqual([])
    expect(buildStemModel(null)).toEqual([])
    expect(buildStemModel({ vocals: [] })).toEqual([])
  })

  it('caps vocal lanes at MAX_VOCAL_LANES', () => {
    const vocals = Array.from({ length: 20 }, (_, i) => ({ id: String(i), url: `blob:${i}` }))
    const lanes = buildStemModel({ instrumental: 'blob:inst', vocals })
    const vocalLanes = lanes.filter((l) => l.kind === 'vocal')
    expect(vocalLanes.length).toBe(MAX_VOCAL_LANES)
  })

  it('skips a vocals entry whose url is null', () => {
    const lanes = buildStemModel({
      instrumental: 'blob:inst',
      vocals: [
        { id: 'lead', url: null },
        { id: 'backing', url: 'blob:backing' },
      ],
    })
    expect(lanes.map((l) => l.key)).toEqual(['backing', 'instrumental'])
  })

  // Lane keys drive the engine registries and the mixer v-for; a collision
  // would silently overwrite a registered lane's audio nodes.
  it('skips a vocal whose id collides with the instrumental lane key', () => {
    const lanes = buildStemModel({
      instrumental: 'blob:inst',
      vocals: [
        { id: 'instrumental', url: 'blob:stray' },
        { id: 'lead', url: 'blob:lead' },
      ],
    })
    expect(lanes.map((l) => l.key)).toEqual(['lead', 'instrumental'])
    expect(lanes.at(-1).url).toBe('blob:inst')   // the bed keeps its own url
  })

  it('dedups duplicate vocal ids — first claim wins', () => {
    const lanes = buildStemModel({
      vocals: [
        { id: '6', name: 'Bob', url: 'blob:first' },
        { id: '6', name: 'Impostor', url: 'blob:second' },
      ],
    })
    expect(lanes).toHaveLength(1)
    expect(lanes[0].url).toBe('blob:first')
    expect(lanes[0].label).toBe('Bob')
  })

  it('null-url and duplicate entries do not consume cap slots', () => {
    const vocals = [
      { id: 'dead', url: null },
      { id: 'dup', url: 'blob:dup' },
      { id: 'dup', url: 'blob:dup2' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: String(i), url: `blob:${i}` })),
    ]
    const lanes = buildStemModel({ vocals })
    expect(lanes.filter((l) => l.kind === 'vocal')).toHaveLength(MAX_VOCAL_LANES)
    // 'dup' + the first 11 numbered ids — the null/dup entries cost nothing.
    expect(lanes.map((l) => l.key)).toEqual(['dup', ...Array.from({ length: 11 }, (_, i) => String(i))])
  })
})
