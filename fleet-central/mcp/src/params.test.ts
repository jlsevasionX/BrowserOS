import { expect, test } from 'bun:test'
import { buildQuery } from './params'

test('omits undefined/null/empty and prefixes with ?', () => {
  expect(buildQuery({ top: 3, bucket: 'hour', host: undefined, q: '' })).toBe('?top=3&bucket=hour')
})

test('returns empty string when nothing to serialize', () => {
  expect(buildQuery({})).toBe('')
  expect(buildQuery({ a: undefined })).toBe('')
})
