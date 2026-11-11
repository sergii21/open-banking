import {
  FOP_RATES,
  type FopCalendarEntry,
  type FopRate,
  type FopReport,
} from '@ledger-lens/contracts';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Alert, Linking, Pressable, Switch, Text, View } from 'react-native';
import { useApp, useStored } from '../app-state';
import { FopFileError, cabinetNumber, dayText, fopReport, importUkrsib } from '../model/fop';
import { pickStatementFiles } from '../platform/files';
import { Amount, Body, Button, Card, Heading, Row, Screen, Segmented } from '../ui/parts';
import { useTheme } from '../ui/theme';

export function statusText(entry: FopCalendarEntry): string {
  switch (entry.status) {
    case 'upcoming':
      return 'Not started';
    case 'in-progress':
      return 'Quarter in progress';
    case 'no-statements':
      return 'Add statements';
    case 'statements-short':
      return 'Statements end too early';
    case 'ready':
      return 'Ready to file';
    case 'paid':
      return 'Tax paid';
  }
}

const ROWS_SHOWN = 60;

/**
 * The ФОП report (single tax, group 3) from the person's own UKRSIB business statements. The files are read on the
 * phone and only their rows are kept; nothing is filed, paid or sent. Every rate and rule is an assumption to
 * confirm with an accountant, and the screen says so.
 */
export function Fop() {
  const app = useApp();
  const t = useTheme();
  const [year, setYear] = useState<string | undefined>(undefined);
  const [rate, setRate] = useState<FopRate>(5);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [allRows, setAllRows] = useState(false);
  const today = app.calendar.today(app.clock.now());
  const report: FopReport | null = useStored(
    ({ store }) => fopReport(store, today, year, rate),
    `${year ?? ''}:${rate}`,
  );

  const add = async (): Promise<void> => {
    setNote(null);
    try {
      const files = await pickStatementFiles();
      if (files.length === 0) return;
      let read = 0;
      let added = 0;
      for (const file of files) {
        const result = await importUkrsib(app.store, app.calendar, file.bytes);
        read += result.rows.read;
        added += result.rows.added;
      }
      setNote(
        `${files.length === 1 ? 'One file' : `${files.length} files`} read: ${read} rows, ${added} new.`,
      );
    } catch (error) {
      setNote(
        error instanceof FopFileError
          ? error.message
          : 'That file could not be read. Export the statement from UKRSIB business as CSV.',
      );
    }
    app.touch();
  };

  const clear = (): void => {
    Alert.alert('Remove the statement rows?', 'The ФОП rows are removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => void app.store.clearFop().then(() => app.touch()),
      },
    ]);
  };

  const copy = async (text: string, what: string): Promise<void> => {
    await Clipboard.setStringAsync(text);
    setNote(`${what} copied: ${text}`);
  };

  const rows = report ? (allRows ? report.rows : report.rows.slice(0, ROWS_SHOWN)) : [];

  return (
    <Screen title="ФОП report">
      <Card>
        <Body muted>
          Income per quarter for a group 3 single-tax ФОП, from your UKRSIB business statements
          (CSV). The files are read on this phone. Nothing is filed or paid here.
        </Body>
        <Button label="Add UKRSIB statements (CSV)" onPress={() => void add()} />
        {note ? <Body>{note}</Body> : null}
        <Segmented
          label="Single tax rate"
          value={rate}
          onChange={setRate}
          options={FOP_RATES.map((value) => ({
            value,
            label: value === 5 ? '5 %, no VAT' : '3 %, with VAT',
          }))}
        />
        {report && report.years.length > 1 ? (
          <Segmented
            label="Year"
            value={report.year}
            onChange={setYear}
            options={report.years.map((value) => ({ value, label: value }))}
          />
        ) : null}
      </Card>

      {report ? (
        <>
          <Card>
            <Heading>Declarations of {report.year}</Heading>
            {report.calendar.map((entry) => (
              <View key={entry.quarter} style={{ gap: 2 }}>
                <Row>
                  <Body>{entry.periodName}</Body>
                  <Body style={{ fontWeight: '600' }}>{statusText(entry)}</Body>
                </Row>
                <Body muted>
                  File by {dayText(entry.fileBy)}, pay by {dayText(entry.payBy)}
                </Body>
              </View>
            ))}
            <Body muted>A weekend or a holiday moves a deadline; that is not worked out here.</Body>
          </Card>

          {report.hasData ? (
            <Card>
              <Heading>Year so far</Heading>
              <Row>
                <Body muted>Income</Body>
                <Amount minor={report.yearIncomeMinor} currency="UAH" />
              </Row>
              <Row>
                <Body muted>Single tax, {report.singleTaxPercent} %</Body>
                <Amount minor={report.yearSingleTaxMinor} currency="UAH" />
              </Row>
              <Row>
                <Body muted>Military levy, {report.militaryLevyPercent} %</Body>
                <Amount minor={report.yearLevyMinor} currency="UAH" />
              </Row>
              {report.limit ? (
                <Body muted>
                  {report.limit.usedPercent} % of the year’s income limit for group 3 is used.
                </Body>
              ) : null}
            </Card>
          ) : null}

          {report.warnings.map((warning) => (
            <Card key={warning} tone="warn">
              <Body>{warning}</Body>
            </Card>
          ))}

          {report.hasData
            ? report.periods.map((period) => (
                <Card key={period.quarter}>
                  <Heading>
                    Quarter {period.quarter} · {period.periodName}
                  </Heading>
                  <Row>
                    <Body muted>Income in the quarter</Body>
                    <Amount minor={period.incomeMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Since 1 January</Body>
                    <Amount minor={period.cumulativeMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Single tax for the quarter</Body>
                    <Amount minor={period.singleTaxMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Paid, per the statements</Body>
                    <Amount minor={period.paidSingleTaxMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Military levy for the quarter</Body>
                    <Amount minor={period.levyMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Paid, per the statements</Body>
                    <Amount minor={period.paidLevyMinor} currency="UAH" />
                  </Row>
                  <Row>
                    <Body muted>Social contribution paid</Body>
                    <Amount minor={period.paidEsvMinor} currency="UAH" />
                  </Row>
                  <Button
                    kind="soft"
                    label={
                      open === period.quarter
                        ? 'Hide the lines for the declaration'
                        : 'Lines for the declaration'
                    }
                    onPress={() => setOpen(open === period.quarter ? null : period.quarter)}
                  />
                  {open === period.quarter
                    ? period.lines.map((line) => (
                        <Pressable
                          key={line.code}
                          accessibilityRole="button"
                          accessibilityLabel={`Copy line ${line.code}: ${cabinetNumber(line.amountMinor)}`}
                          onPress={() =>
                            void copy(cabinetNumber(line.amountMinor), `Line ${line.code}`)
                          }
                          style={{ paddingVertical: 6, gap: 2 }}
                        >
                          <Body muted>
                            {line.code} · {line.label}
                          </Body>
                          <Row>
                            <Text
                              style={{
                                color: t.text,
                                fontSize: 17,
                                fontWeight: '600',
                                fontVariant: ['tabular-nums'],
                              }}
                            >
                              {cabinetNumber(line.amountMinor)}
                            </Text>
                            <Text style={{ color: t.accent, fontSize: 15 }}>Copy</Text>
                          </Row>
                        </Pressable>
                      ))
                    : null}
                </Card>
              ))
            : null}

          {report.hasData ? (
            <Card>
              <Heading>Rows</Heading>
              <Body muted>Switch a row on to count it as income, off to leave it out.</Body>
              {rows.map((row) => (
                <View
                  key={row.id}
                  style={{
                    paddingVertical: 8,
                    borderTopColor: t.line,
                    borderTopWidth: 0.5,
                    gap: 4,
                  }}
                >
                  <Row>
                    <Body style={{ flex: 1 }}>
                      {dayText(row.day)} · •• {row.account}
                    </Body>
                    <Amount
                      minor={row.direction === 'in' ? row.amountMinor : -row.amountMinor}
                      currency={row.currency}
                      signed
                    />
                  </Row>
                  <Body muted>{row.counterparty || row.purpose}</Body>
                  <Row>
                    <Body muted style={{ flex: 1 }}>
                      {row.reason}
                      {row.chosen ? ' (your choice)' : ''}
                    </Body>
                    {row.direction === 'in' ? (
                      <Switch
                        accessibilityLabel={`Count as income: ${dayText(row.day)}`}
                        value={row.counted}
                        onValueChange={(counted) =>
                          void app.store.setFopOverride(row.id, counted).then(() => app.touch())
                        }
                      />
                    ) : null}
                  </Row>
                </View>
              ))}
              {!allRows && report.rows.length > ROWS_SHOWN ? (
                <Button
                  kind="soft"
                  label={`Show all ${report.rows.length} rows`}
                  onPress={() => setAllRows(true)}
                />
              ) : null}
              <Button kind="danger" label="Remove the statement rows" onPress={clear} />
            </Card>
          ) : null}
        </>
      ) : null}

      <Card>
        <Heading>How to: export, import, file</Heading>
        <Body muted>
          1. In UKRSIB business open Statements and export CSV, one file for all accounts or one per
          account, from 1 January. 2. Save it to Files on this phone and add it here. 3. Type the
          lines into a new declaration in the tax cabinet.
        </Body>
        <Button
          kind="soft"
          label="UKRSIB business: statements"
          onPress={() =>
            void Linking.openURL('https://business.ukrsibbank.com/extracts/statements')
          }
        />
        <Button
          kind="soft"
          label="Tax cabinet: reporting"
          onPress={() => void Linking.openURL('https://cabinet.tax.gov.ua/reporting')}
        />
        <Body muted>
          Not tax advice. The rates, the income limit and the rule that foreign currency counts at
          the National Bank’s rate on the day it arrives are assumptions: confirm them with an
          accountant.
        </Body>
      </Card>
    </Screen>
  );
}
