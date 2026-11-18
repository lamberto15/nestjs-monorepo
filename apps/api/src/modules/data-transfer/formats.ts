import type { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import {
  addDataValidation,
  autoFitColumns,
  type CellValue,
  createXlsxWriter,
  EncryptedFileError,
  estimateColumnWidths,
  type StreamSheet,
  Workbook,
  writeXlsx,
  XlsxParseError,
  type XlsxRow,
  xlsxRows,
  ZipLimitError,
} from 'turbosheet';
import { CsvError, csvRows, formatCsvRow } from 'turbosheet/csv';
import type {
  ImportColumn,
  TransferColumn,
  TransferFormat,
} from './data-transfer.types.js';
import { exampleOf } from './import-columns.js';
import {
  headerColumn,
  type ImportMapping,
  renameHeaders,
} from './import-mapping.js';
import { instantOf, localDateTime, wallClock } from './zoned-time.js';

/**
 * The file formats, streamed both ways through turbosheet (the owner's
 * library, for CSV and Excel alike): a large export or import never sits
 * in memory. turbosheet is used only here.
 */

export const CONTENT_TYPES: Record<TransferFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Text an export wrote with a leading quote (`'=1+1`, `'+63 912`), so a spreadsheet shows it instead of running it. */
const QUOTED_FORMULA = /^'[=+\-@\t\r]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** Excel's number formats of a date-time and a date cell. */
const DATETIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';
const DAY_FORMAT = 'yyyy-mm-dd';

/** What a spreadsheet may unpack to, and how many files it may hold. */
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;

/** Rows of an Excel template that get a column's dropdown. */
const TEMPLATE_ROWS = 1_000;

const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const asDate = (value: unknown) =>
  value instanceof Date
    ? value
    : typeof value === 'string' && !Number.isNaN(Date.parse(value))
      ? new Date(value)
      : undefined;

/** A date-time column's header in a file: `createdAt (Asia/Dubai)`. */
const zonedHeader = (name: string, timeZone: string) => `${name} (${timeZone})`;

/** A value as a cell: objects as JSON, nothing as empty. */
const cell = (value: unknown): CellValue => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value as string | number | boolean;
};

/** A moment as an Excel date cell: the wall clock of the zone, given as UTC (Excel dates have none). */
const excelMoment = (date: Date, timeZone: string) => {
  const { date: day, time, ms } = wallClock(date, timeZone);
  return new Date(`${day}T${time}.${ms}Z`);
};

/**
 * Waits for `stream` to drain; rejects when it fails or closes first (a
 * consumer that stopped reading never drains it).
 */
function drained(stream: EventEmitter) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The file stream closed before it was written.'));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

/**
 * Writes rows into `output` in `format`, times in `timeZone`: date-time
 * columns as local time with the zone in their header (Excel's as date
 * cells), `date` columns as days. Text a spreadsheet would run as a formula
 * gets a leading quote. `end()` finishes the file, `destroy(error)`
 * abandons it (the consumer of `output` sees the error).
 */
export function createWriter(
  format: TransferFormat,
  columns: readonly TransferColumn[],
  timeZone = 'UTC',
) {
  const output = new PassThrough();
  const headers = columns.map((column) => {
    const name = column.header ?? column.key;
    return column.type === 'datetime' ? zonedHeader(name, timeZone) : name;
  });
  const push = async (chunk: string | Uint8Array) => {
    if (output.destroyed) throw new Error('The file stream was closed.');
    if (!output.write(chunk)) await drained(output);
  };
  const values = (row: Record<string, unknown>) =>
    columns.map((column): CellValue => {
      const value = column.value ? column.value(row) : row[column.key];
      if (column.type === 'datetime') {
        const date = asDate(value);
        if (date) {
          return format === 'csv'
            ? localDateTime(date, timeZone)
            : excelMoment(date, timeZone);
        }
      }
      if (format === 'xlsx' && column.type === 'date' && isDay(value)) {
        return new Date(`${value}T00:00:00Z`);
      }
      const shown = cell(value);
      // turbosheet's escapeFormulas covers CSV; Excel's text cells get the same quote.
      return format === 'xlsx' &&
        typeof shown === 'string' &&
        FORMULA_START.test(shown)
        ? `'${shown}`
        : shown;
    });

  if (format === 'csv') {
    const line = (row: readonly CellValue[]) =>
      `${formatCsvRow(row, { escapeFormulas: true })}\r\n`;
    let started = false;
    return {
      output,
      write: async (rows: Record<string, unknown>[]) => {
        if (!started) {
          started = true;
          // A BOM: Excel then reads the file as UTF-8.
          await push(`\u{feff}${line(headers)}`);
        }
        for (const row of rows) await push(line(values(row)));
      },
      end: async () => {
        if (!started) await push(`\u{feff}${line(headers)}`);
        output.end();
      },
      destroy: (error: Error) => void output.destroy(error),
    };
  }

  const numFmts = columns.map((column) =>
    column.type === 'date'
      ? DAY_FORMAT
      : column.type === 'datetime'
        ? DATETIME_FORMAT
        : undefined,
  );
  const writer = createXlsxWriter({
    // Inline strings: rows are flushed as written, nothing kept per string.
    strings: 'inline',
    sink: (chunk) => push(chunk),
  });
  let sheet: StreamSheet | undefined;
  // The sheet starts with the first batch, so its columns are as wide as
  // that batch's values (a streamed sheet can't be fitted afterwards).
  const start = (sample: CellValue[][]) => {
    const widths = estimateColumnWidths([headers, ...sample], {
      numFmts,
      max: 60,
    });
    const started = writer.addWorksheet('Data', {
      columns: columns.map((_, i) => ({
        width: widths[i],
        style: numFmts[i] ? { numFmt: numFmts[i] } : undefined,
      })),
      freeze: 1,
    });
    started.addRow(headers);
    return started;
  };
  return {
    output,
    write: async (rows: Record<string, unknown>[]) => {
      const lines = rows.map(values);
      sheet ??= start(lines);
      for (const line of lines) sheet.addRow(line);
      await sheet.flush();
    },
    end: async () => {
      sheet ??= start([]);
      await writer.end();
      output.end();
    },
    destroy: (error: Error) => void output.destroy(error),
  };
}

/** The texts of an Excel template's guide, in the reader's language. */
export interface TemplateGuide {
  sheets: { data: string; columns: string };
  /** The guide's header: column, required, type, format, example, description. */
  headers: string[];
  /** The guide's line for one column, under those headers. */
  line(column: ImportColumn): string[];
  /** Said above the guide: the example row is to be replaced. */
  note: string;
}

/**
 * An import template: the columns' headers and one example row, as an
 * import reads them (date-times local to `timeZone`, the zone in the
 * header; lists comma-separated). The Excel one adds the guide sheet, a
 * dropdown on every column with choices, and date cells for dates. Two
 * rows: built whole, in memory.
 */
export async function createTemplate(
  format: TransferFormat,
  columns: readonly ImportColumn[],
  timeZone: string,
  guide: TemplateGuide,
  now = new Date(),
): Promise<Buffer> {
  const example = Object.fromEntries(
    columns.map((column) => {
      const value = exampleOf(column, now, timeZone);
      return [column.name, Array.isArray(value) ? value.join(', ') : value];
    }),
  );
  if (format === 'csv') {
    const writer = createWriter(
      format,
      columns.map((column) => ({
        key: column.name,
        ...((column.type === 'datetime' || column.type === 'date') && {
          type: column.type,
        }),
      })),
      timeZone,
    );
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of writer.output) chunks.push(chunk as Buffer);
    })();
    await writer.write([example]);
    await writer.end();
    await collected;
    return Buffer.concat(chunks);
  }

  const workbook = new Workbook();
  const data = workbook.addWorksheet(guide.sheets.data);
  data.freeze(1);
  const help = workbook.addWorksheet(guide.sheets.columns);
  // The dropdowns' choices: a range, not an inline list (Excel caps that at
  // 255 characters, and a comma would split a choice).
  const lists = workbook.addWorksheet('Lists', { state: 'veryHidden' });
  data.addRow(
    columns.map((column) =>
      column.type === 'datetime'
        ? zonedHeader(column.name, timeZone)
        : column.name,
    ),
    { font: { bold: true } },
  );
  data.addRow(
    columns.map((column) => {
      const value = example[column.name];
      if (column.type === 'date' && isDay(value)) {
        return new Date(`${value}T00:00:00Z`);
      }
      if (column.type === 'datetime' && value instanceof Date) {
        return excelMoment(value, timeZone);
      }
      return cell(value);
    }),
  );
  columns.forEach((column, i) => {
    const sheetColumn = data.getColumn(i + 1);
    sheetColumn.width = Math.max(14, column.name.length + 4);
    if (column.type === 'datetime') {
      data.setStyle(2, i + 1, { numFmt: DATETIME_FORMAT });
      sheetColumn.width = Math.max(sheetColumn.width, 22);
    } else if (column.type === 'date') {
      data.setStyle(2, i + 1, { numFmt: DAY_FORMAT });
    }
    const choices =
      column.type === 'boolean'
        ? ['true', 'false']
        : column.type === 'text'
          ? column.options
          : undefined;
    if (!choices?.length) return;
    choices.forEach((choice, row) => lists.setCell(row + 1, i + 1, choice));
    const letter = sheetColumn.letter;
    addDataValidation(data, {
      sqref: `${letter}2:${letter}${TEMPLATE_ROWS + 1}`,
      type: 'list',
      allowBlank: !column.required,
      formula1: `Lists!$${letter}$1:$${letter}$${choices.length}`,
      showErrorMessage: true,
    });
  });
  help.addRow([guide.note], { font: { italic: true } });
  help.addRow([]);
  help.addRow(guide.headers, { font: { bold: true } });
  for (const column of columns) help.addRow(guide.line(column));
  autoFitColumns(help, { rows: { from: 3 }, min: 10, max: 60 });
  const bytes = writeXlsx(workbook);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A file that isn't what it claims, as the person who sent it reads it. */
export class FormatError extends Error {}

/**
 * The records of a file, with their row numbers (1: the first after the
 * header). Values come as text, except a date cell of one of `dateColumns`
 * (read as its day). A `mapping` renames the file's headers first (or
 * ignores a column). Zoned headers (`createdAt (Asia/Dubai)`) are read as
 * their column, their local times as ISO 8601 UTC; the quote an export puts
 * before formula-like text is removed, as Excel removes a typed one. So an
 * exported file imports back to what was exported.
 */
export async function* readRecords(
  format: TransferFormat,
  input: Readable,
  {
    dateColumns = new Set(),
    mapping,
  }: { dateColumns?: ReadonlySet<string>; mapping?: ImportMapping } = {},
): AsyncGenerator<{ row: number; record: Record<string, unknown> }> {
  try {
    yield* format === 'csv'
      ? csvRecords(input, mapping)
      : xlsxRecords(input, dateColumns, mapping);
  } finally {
    // Read to the end, failed, or left early: the source is released.
    input.destroy();
  }
}

async function* csvRecords(input: Readable, mapping?: ImportMapping) {
  let headers: (string | null)[] | undefined;
  let row = 0;
  try {
    for await (const cells of csvRows(input as AsyncIterable<Uint8Array>)) {
      if (!headers) {
        headers = renameHeaders(
          cells.map((header) => header.trim()),
          mapping,
        );
        continue;
      }
      yield {
        row: ++row,
        record: fromCells(
          Object.fromEntries(
            headers.flatMap((header, i) =>
              header === null ? [] : [[header, (cells[i] ?? '').trim()]],
            ),
          ),
        ),
      };
    }
  } catch (error) {
    throw error instanceof CsvError
      ? new FormatError(`The file is not valid CSV: ${error.message}`)
      : error;
  }
}

/**
 * The workbook's first sheet, one row at a time, as the upload streams in:
 * the reader checks the zip while it inflates, so a zip bomb stops before
 * it fills the worker; a sheet stored before the styles is held compressed
 * until they arrive (profile 'low-memory').
 */
async function* xlsxRecords(
  input: Readable,
  dateColumns: ReadonlySet<string>,
  mapping?: ImportMapping,
) {
  const rows = xlsxRows(input as AsyncIterable<Uint8Array>, {
    limits: { maxEntries: MAX_ZIP_ENTRIES, maxTotalBytes: MAX_UNZIPPED_BYTES },
    profile: 'low-memory',
  });
  let headers: (string | null)[] | undefined;
  let row = 0;
  try {
    for await (const line of firstSheet(rows)) {
      const cells = line.cells;
      if (!headers) {
        headers = renameHeaders(
          Array.from(cells, (header) =>
            header === null || header === undefined
              ? ''
              : cellText(header).trim(),
          ),
          mapping,
        );
        continue;
      }
      yield {
        row: ++row,
        record: fromCells(
          Object.fromEntries(
            headers.flatMap((header, i) => {
              if (header === null) return [];
              const value = cells[i];
              if (value === null || value === undefined) return [[header, '']];
              if (value instanceof Date) {
                if (dateColumns.has(header)) {
                  return [[header, value.toISOString().slice(0, 10)]];
                }
                // A zoned column's date cell is its wall clock, given as UTC.
                if (headerColumn(header).zone) {
                  return [
                    [
                      header,
                      value.toISOString().slice(0, 23).replace('T', ' '),
                    ],
                  ];
                }
              }
              return [[header, cellText(value)]];
            }),
          ),
        ),
      };
    }
  } catch (error) {
    throw xlsxFormatError(error);
  }
}

async function* firstSheet(rows: AsyncIterable<XlsxRow>) {
  for await (const row of rows) {
    if (row.sheetIndex === 0) yield row;
  }
}

/** The reader's errors, as the person reads them; anything else (the source failing) as it is. */
function xlsxFormatError(error: unknown) {
  if (error instanceof EncryptedFileError) {
    return new FormatError(
      'The spreadsheet is password-protected: save it without a password.',
    );
  }
  if (
    error instanceof ZipLimitError &&
    /^(Too many|Zip (entry|total))/.test(error.message)
  ) {
    return new FormatError('The spreadsheet is too large to import.');
  }
  if (error instanceof ZipLimitError || error instanceof XlsxParseError) {
    return new FormatError('The spreadsheet is not a valid .xlsx file.');
  }
  return error;
}

/** A record as its cells mean it (see readRecords). */
function fromCells(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([header, value]) => {
      const { key, zone } = headerColumn(header);
      if (typeof value !== 'string') return [key, value];
      const text = QUOTED_FORMULA.test(value) ? value.slice(1) : value;
      if (zone && text === '') return [key, ''];
      return [key, zone ? (instantOf(text, zone) ?? text) : text];
    }),
  );
}

/** A spreadsheet cell as text: dates in ISO 8601, formulas by their result, rich text joined. */
function cellText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    const found = value as {
      result?: unknown;
      text?: unknown;
      richText?: { text: string }[];
    };
    if (found.richText) return found.richText.map((part) => part.text).join('');
    if (typeof found.text === 'string') return found.text;
    if (found.result !== undefined) return cellText(found.result);
    return JSON.stringify(value);
  }
  return String(value as string | number | boolean);
}

/**
 * Recognizes an upload by its first bytes: Excel by the zip signature, CSV
 * as plain text (no control characters but tabs and line breaks).
 */
export function detectTextFormat(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return CONTENT_TYPES.xlsx;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // oxlint-disable-next-line no-control-regex
  return /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{fffd}]/u.test(text)
    ? undefined
    : CONTENT_TYPES.csv;
}

/** The format of a stored upload, from the type the storage detected. */
export function formatOf(contentType: string): TransferFormat | undefined {
  if (contentType.startsWith('text/csv')) return 'csv';
  if (
    contentType.includes('spreadsheetml') ||
    contentType.startsWith('application/zip')
  ) {
    return 'xlsx';
  }
  return undefined;
}
