import { defineEvent } from './events.js';

describe('defineEvent', () => {
  it('takes full-stop delimited types', () => {
    expect(defineEvent('note.published').type).toBe('note.published');
    expect(defineEvent('note.title-changed').type).toBe('note.title-changed');
  });

  it('refuses anything else', () => {
    for (const type of ['note', 'Note.published', 'note..x', 'note.', '']) {
      expect(() => defineEvent(type)).toThrow(/not an event type/);
    }
  });
});
