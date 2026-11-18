import { Badge } from '@nestjs-monorepo/ui/components/badge';
import { Button } from '@nestjs-monorepo/ui/components/button';
import { Spinner } from '@nestjs-monorepo/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';
import {
  opsDiagnosticsQuery,
  useTestDiagnostic,
  type Diagnostic,
} from './queries';

const variant = (state: Diagnostic['state']) =>
  state === 'ok'
    ? 'default'
    : state === 'unavailable'
      ? 'destructive'
      : 'outline';

/**
 * The integrations (database, Redis, workers, mail, storage, realtime):
 * each one's state, driver, the masked error, and a safe test
 * for those that have one. The API's texts are remote: shown as text.
 */
export function DiagnosticsPanel() {
  const { t } = useTranslation('ops');
  const diagnostics = useQuery(opsDiagnosticsQuery);
  const test = useTestDiagnostic();
  const canTest = useCan('Access.testIntegrations');
  const [testing, setTesting] = useState<string | null>(null);
  // A module may declare an integration the page has no name for: its own name.
  const checkLabel = (name: string) =>
    t(`diagnostics.checks.${name}`, { defaultValue: name });
  if (diagnostics.isPending) {
    return <Spinner />;
  }
  if (diagnostics.isError) {
    return <FormAlert message={errorMessage(diagnostics.error)} />;
  }
  const run = async (name: Diagnostic['name']) => {
    setTesting(name);
    try {
      const result = await test.mutateAsync(name);
      if (result.ok) {
        toast.success(
          t('diagnostics.passed', {
            check: checkLabel(name),
            ms: result.durationMs,
          }),
        );
      } else {
        toast.error(t('diagnostics.failed', { check: checkLabel(name) }), {
          description: result.detail ?? undefined,
        });
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setTesting(null);
    }
  };
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('diagnostics.check')}</TableHead>
            <TableHead>{t('diagnostics.state')}</TableHead>
            <TableHead>{t('diagnostics.driver')}</TableHead>
            <TableHead>{t('diagnostics.details')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('diagnostics.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diagnostics.data.items.map((item) => (
            <TableRow key={item.name}>
              <TableCell>{checkLabel(item.name)}</TableCell>
              <TableCell>
                <Badge variant={variant(item.state)}>
                  {t(`diagnostics.states.${item.state}`)}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {item.driver ?? '—'}
              </TableCell>
              <TableCell className="max-w-md break-words whitespace-normal text-xs">
                {item.detail && <p>{item.detail}</p>}
              </TableCell>
              <TableCell className="text-end">
                {canTest && item.testable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing !== null}
                    onClick={() => void run(item.name)}
                  >
                    {testing === item.name ? (
                      <Spinner />
                    ) : (
                      t('diagnostics.test')
                    )}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
