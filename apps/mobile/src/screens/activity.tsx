import { useMemo, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { useApp, useStored } from '../app-state';
import type { TransactionRow } from '../data/db';
import { dayText } from '../model/fop';
import { Amount, Body, Button } from '../ui/parts';
import { useTheme } from '../ui/theme';

const PAGE = 100;

/** Every transaction on the phone, newest first, searched as the person types: the search never leaves the phone. */
export function Activity() {
  const app = useApp();
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const key = `${query}\u0001${limit}`;
  const data = useStored(
    async ({ store }) => ({
      rows: await store.transactions(query, limit + 1),
      total: await store.transactionCount(),
      names: new Map((await store.accounts()).map((a) => [a.providerAccountId, a.name])),
    }),
    key,
  );
  const rows = useMemo(() => (data?.rows ?? []).slice(0, limit), [data, limit]);
  const more = (data?.rows.length ?? 0) > limit;

  const item = ({ item: row }: { item: TransactionRow }) => (
    <View
      style={{
        flexDirection: 'row',
        gap: 12,
        paddingVertical: 10,
        borderBottomColor: t.line,
        borderBottomWidth: 0.5,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16 }} numberOfLines={2}>
          {row.description}
        </Text>
        <Text style={{ color: t.text2, fontSize: 13 }} numberOfLines={2}>
          {dayText(app.calendar.dayKey(row.ts))} · {data?.names.get(row.accountId) ?? 'Account'}
          {row.status === 'pending' ? ' · On hold' : ''}
          {row.comment ? ` · ${row.comment}` : ''}
        </Text>
      </View>
      <Amount minor={row.amountMinor} currency={row.currency} signed />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingHorizontal: 16, paddingTop: 16 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 28, fontWeight: '700' }}>
        Transactions
      </Text>
      <TextInput
        accessibilityLabel="Search transactions"
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setLimit(PAGE);
        }}
        placeholder="Search"
        placeholderTextColor={t.text2}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        style={{
          color: t.text,
          backgroundColor: t.surface2,
          borderRadius: 10,
          paddingHorizontal: 12,
          minHeight: 44,
          fontSize: 16,
          marginVertical: 12,
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={item}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Body muted>
            {data === null
              ? ''
              : data.total === 0
                ? 'No transactions yet. They appear as the history loads.'
                : 'Nothing matches the search.'}
          </Body>
        }
        ListFooterComponent={
          more ? (
            <View style={{ paddingVertical: 12 }}>
              <Button kind="soft" label="Show more" onPress={() => setLimit(limit + PAGE)} />
            </View>
          ) : undefined
        }
      />
    </View>
  );
}
