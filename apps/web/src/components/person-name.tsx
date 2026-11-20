import { usePeopleNames, useUnitNames } from '@/lib/people';
import { useRecordNames } from '@/lib/record-names';

/** A principal's name (`user:<id>`, `client:<id>`); the key itself until known. */
export function PersonName({ value }: { value: string }) {
  return <>{usePeopleNames([value]).name(value)}</>;
}

/** A unit's name; its id until known. */
export function UnitName({ value }: { value: string }) {
  return <>{useUnitNames([value]).name(value)}</>;
}

/** A record's title by its subject and id; its id until known. */
export function RecordName({
  subject,
  value,
}: {
  subject: string;
  value: string;
}) {
  return <>{useRecordNames(subject, [value]).name(value)}</>;
}
