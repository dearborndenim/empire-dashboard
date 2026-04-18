import { truncateMessage } from '../src/truncate';

describe('truncateMessage', () => {
  it('returns empty string for nullish input', () => {
    expect(truncateMessage(undefined)).toBe('');
    expect(truncateMessage(null)).toBe('');
    expect(truncateMessage('')).toBe('');
  });

  it('passes through short messages unchanged', () => {
    expect(truncateMessage('feat: add tiny thing')).toBe('feat: add tiny thing');
  });

  it('collapses multi-line messages to the first line', () => {
    expect(truncateMessage('first line\nbody here\nmore')).toBe('first line');
  });

  it('truncates messages longer than the max and appends an ellipsis', () => {
    const msg = 'a'.repeat(120);
    const result = truncateMessage(msg, 80);
    // Visible length including the ellipsis
    expect([...result].length).toBe(80);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('defaults to 80 chars when no max provided', () => {
    const msg = 'x'.repeat(200);
    const result = truncateMessage(msg);
    expect([...result].length).toBe(80);
  });

  it('respects custom max', () => {
    expect(truncateMessage('hello world', 5)).toBe('hell\u2026');
  });

  it('trims trailing whitespace before appending ellipsis', () => {
    const result = truncateMessage('hello       world extra words here', 10);
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result).not.toMatch(/ \u2026$/);
  });

  it('handles max <= 1 by returning just the ellipsis', () => {
    expect(truncateMessage('anything long', 1)).toBe('\u2026');
    expect(truncateMessage('anything long', 0)).toBe('\u2026');
  });

  it('leaves exactly-max-length strings untouched', () => {
    const msg = 'a'.repeat(80);
    expect(truncateMessage(msg, 80)).toBe(msg);
  });
});
