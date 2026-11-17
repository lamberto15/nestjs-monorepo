import { z } from 'zod';
import {
  baseUrl,
  choice,
  flag,
  integer,
  list,
  optional,
  required,
  withDefault,
} from './env.helpers.js';
import { readEnv } from './env.js';

describe('env helpers', () => {
  it('treat FOO= as not set', () => {
    const schema = z.object({
      A: optional(),
      B: withDefault('x'),
      C: integer(5, { min: 1 }),
      D: flag('on'),
      E: choice(['a', 'b'], 'b'),
      F: list(),
      G: baseUrl(),
      H: baseUrl('http://localhost:3000/'),
    });
    expect(
      readEnv(schema, {
        A: '',
        B: ' ',
        C: '',
        D: '',
        E: '',
        F: '',
        G: '',
        H: '',
      }),
    ).toEqual({
      A: undefined,
      B: 'x',
      C: 5,
      D: true,
      E: 'b',
      F: [],
      G: undefined,
      H: 'http://localhost:3000',
    });
  });

  it('convert the values given', () => {
    const schema = z.object({
      C: integer(5, { min: 1, max: 9 }),
      D: flag('on'),
      F: list(),
      G: baseUrl(),
    });
    expect(
      readEnv(schema, {
        C: '7',
        D: 'off',
        F: ' a, b ,,c',
        G: 'https://x.io//',
      }),
    ).toEqual({ C: 7, D: false, F: ['a', 'b', 'c'], G: 'https://x.io' });
  });

  it('refuse a bad value and an unset required one', () => {
    const schema = z.object({
      A: required(),
      C: integer(5, { max: 9 }),
      E: choice(['a'], 'a'),
    });
    expect(() => readEnv(schema, { A: '', C: '10', E: 'z' })).toThrow(
      /A: .+\nC: .+\nE: /,
    );
  });
});
