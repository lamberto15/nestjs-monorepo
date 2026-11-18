import { Readable } from 'node:stream';
import { readXlsx, Workbook, writeXlsx } from 'turbosheet';
import type { TransferFormat } from './data-transfer.types.js';
import { createWriter, readRecords } from './formats.js';
import { MappingError } from './import-mapping.js';
import { instantOf, localDateTime } from './zoned-time.js';

describe('localDateTime', () => {
  it('writes the local time as spreadsheets read a date', () => {
    expect(
      localDateTime(new Date('2026-10-15T14:26:23.799Z'), 'Asia/Singapore'),
    ).toBe('2026-10-15 22:26:23');
  });
});

describe('instantOf', () => {
  it.each([
    ['2026-10-15 22:26:23', 'Asia/Singapore', '2026-10-15T14:26:23.000Z'],
    ['2026-10-15T22:26:23.799', 'Asia/Singapore', '2026-10-15T14:26:23.799Z'],
    ['2026-10-15 18:30', 'Asia/Dubai', '2026-10-15T14:30:00.000Z'],
    ['2026-01-15 09:30:00', 'America/New_York', '2026-01-15T14:30:00.000Z'],
    ['2026-07-15 09:30:00', 'America/New_York', '2026-07-15T13:30:00.000Z'],
  ])('reads %s in %s', (text, zone, expected) => {
    expect(instantOf(text, zone)).toBe(expected);
  });

  it('takes the earlier moment in the hour the clock goes back', () => {
    // New York, 2026-11-01: 01:30 happens at -04:00, then again at -05:00.
    expect(instantOf('2026-11-01 01:30:00', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('moves a time the clock skips forward by the gap', () => {
    // New York, 2026-03-08: 02:30 does not exist; read at the old offset.
    expect(instantOf('2026-03-08 02:30:00', 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('leaves what is not a local time to the schema', () => {
    for (const text of [
      '2026-10-15T22:26:23+08:00',
      '2026-10-15T14:26:23Z',
      '2026-02-30 10:00:00',
      'tomorrow',
    ]) {
      expect(instantOf(text, 'Asia/Singapore')).toBeUndefined();
    }
  });
});

describe('date-time columns', () => {
  const columns = [
    { key: 'title' },
    { key: 'createdAt', type: 'datetime' },
  ] as const;
  const createdAt = new Date('2026-10-15T14:26:23.799Z');

  async function roundTrip(format: TransferFormat) {
    const writer = createWriter(format, columns, 'Asia/Singapore');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([{ title: 'One', createdAt }]);
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file))) {
      records.push(record);
    }
    return { file, records };
  }

  it('writes CSV in local time, the zone in the header', async () => {
    const { file } = await roundTrip('csv');
    expect(file.toString('utf8').replace(/^\uFEFF/, '')).toBe(
      'title,createdAt (Asia/Singapore)\r\nOne,2026-10-15 22:26:23\r\n',
    );
  });

  it.each(['csv', 'xlsx'] as const)(
    'imports %s back to the same moment, under the column name',
    async (format) => {
      const { records } = await roundTrip(format);
      expect(records).toEqual([
        {
          title: 'One',
          // CSV keeps seconds; an Excel date cell keeps the milliseconds.
          createdAt:
            format === 'csv'
              ? '2026-10-15T14:26:23.000Z'
              : '2026-10-15T14:26:23.799Z',
        },
      ]);
    },
  );
});

describe('formula-like text', () => {
  const columns = [{ key: 'title' }] as const;
  const titles = ['=1+1', '+63 912', '-5', '@cmd', "'quoted", 'plain'];

  async function roundTrip(format: TransferFormat) {
    const writer = createWriter(format, columns, 'UTC');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write(titles.map((title) => ({ title })));
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file))) {
      records.push(record);
    }
    return { file, records };
  }

  it('is quoted in CSV so a spreadsheet shows it instead of running it', async () => {
    const { file } = await roundTrip('csv');
    expect(file.toString('utf8').replace(/^\uFEFF/, '')).toBe(
      "title\r\n'=1+1\r\n'+63 912\r\n'-5\r\n'@cmd\r\n'quoted\r\nplain\r\n",
    );
  });

  it.each(['csv', 'xlsx'] as const)(
    'comes back from %s as it was written (the quote is not part of the value)',
    async (format) => {
      const { records } = await roundTrip(format);
      expect(records.map((record) => record.title)).toEqual(titles);
    },
  );
});

describe('date columns', () => {
  const columns = [{ key: 'day', type: 'date' }] as const;

  async function roundTrip(format: TransferFormat, dateColumns?: Set<string>) {
    const writer = createWriter(format, columns, 'UTC');
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([{ day: '2026-01-05' }, { day: 'soon' }]);
    await writer.end();
    await collected;
    const file = Buffer.concat(chunks);
    const records = [];
    for await (const { record } of readRecords(format, Readable.from(file), {
      dateColumns,
    })) {
      records.push(record.day);
    }
    return records;
  }

  it('is text in CSV', async () => {
    expect(await roundTrip('csv')).toEqual(['2026-01-05', 'soon']);
  });

  it('is a date cell in Excel, read back as the day under a date column', async () => {
    expect(await roundTrip('xlsx', new Set(['day']))).toEqual([
      '2026-01-05',
      'soon',
    ]);
    // Not known as a date column: the cell's moment, in ISO 8601.
    expect(await roundTrip('xlsx')).toEqual([
      '2026-01-05T00:00:00.000Z',
      'soon',
    ]);
  });
});

describe('Excel exports', () => {
  async function exported(rows: Record<string, unknown>[][]) {
    const writer = createWriter('xlsx', [
      { key: 'title' },
      { key: 'day', type: 'date' },
    ]);
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    for (const batch of rows) await writer.write(batch);
    await writer.end();
    await collected;
    return readXlsx(Buffer.concat(chunks)).worksheets[0]!;
  }

  it('freezes the header and sizes the columns from the first batch', async () => {
    const sheet = await exported([
      [{ title: 'A title long enough to widen its column', day: '2026-01-05' }],
      [{ title: 'Second batch', day: '2026-01-06' }],
    ]);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.getColumn(1).width).toBeGreaterThan(30);
    expect(sheet.getCell('B3').numFmt).toBe('yyyy-mm-dd');
    expect(sheet.getValue('A3')).toBe('Second batch');
  });

  it('writes the header of an export without rows', async () => {
    const sheet = await exported([]);
    expect(sheet.getRow(1).values).toEqual([undefined, 'title', 'day']);
    expect(sheet.rowCount).toBe(1);
  });
});

describe('readRecords with a column mapping', () => {
  const read = async (
    format: TransferFormat,
    file: string | Buffer,
    options: Parameters<typeof readRecords>[2],
  ) => {
    const records = [];
    for await (const { record } of readRecords(
      format,
      Readable.from([file]),
      options,
    )) {
      records.push(record);
    }
    return records;
  };

  it('renames, ignores and reads the zone a target names; other columns keep their name', async () => {
    const csv =
      'Name,When,Internal,Area,body\nOne,2026-10-15 18:30:00,x,North,Hi\n';
    expect(
      await read('csv', csv, {
        mapping: {
          Name: 'title',
          When: 'dueAt (Asia/Dubai)',
          Internal: null,
          Area: 'custom.region',
        },
      }),
    ).toEqual([
      {
        title: 'One',
        dueAt: '2026-10-15T14:30:00.000Z',
        'custom.region': 'North',
        body: 'Hi',
      },
    ]);
  });

  it('reads an Excel date cell as the day under a date target', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Birthday']);
    sheet.addRow([new Date('2026-01-05T00:00:00Z')]);
    const file = Buffer.from(writeXlsx(workbook));
    expect(
      await read('xlsx', file, {
        dateColumns: new Set(['day']),
        mapping: { Birthday: 'day' },
      }),
    ).toEqual([{ day: '2026-01-05' }]);
  });

  it('refuses two columns that end up with one name', async () => {
    await expect(
      read('csv', 'title,Name\nA,B\n', { mapping: { Name: 'title' } }),
    ).rejects.toThrow(MappingError);
  });
});

describe('streaming spreadsheet imports (#618)', () => {
  const read = async (file: Buffer) => {
    const records = [];
    for await (const { record } of readRecords('xlsx', Readable.from(file))) {
      records.push(record);
    }
    return records;
  };

  it('refuses what is not a valid .xlsx', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['title']);
    for (let i = 0; i < 2_000; i++) sheet.addRow([`Row ${i}`]);
    const file = Buffer.from(writeXlsx(workbook));
    await expect(read(file.subarray(0, file.length / 2))).rejects.toThrow(
      'not a valid .xlsx',
    );
  });

  it("reads a workbook of several sheets: the first sheet's rows", async () => {
    const workbook = new Workbook();
    const first = workbook.addWorksheet('First');
    first.addRow(['title']);
    first.addRow(['One']);
    workbook.addWorksheet('Second').addRow(['other']);
    expect(await read(Buffer.from(writeXlsx(workbook)))).toEqual([
      { title: 'One' },
    ]);
  });
});
