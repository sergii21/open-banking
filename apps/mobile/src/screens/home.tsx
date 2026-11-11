import { RefreshControl, View } from 'react-native';
import { useApp, useStored } from '../app-state';
import type { SyncState } from '../bank/sync';
import { buildOverview } from '../model/overview';
import { Amount, Body, Button, Card, Heading, Row, Screen } from '../ui/parts';

/** The loader in words: what is happening and why it takes the time it takes. */
export function syncText(state: SyncState): string {
  const left = state.windowsTotal - state.windowsDone;
  const minutes = Math.max(1, left);
  switch (state.status) {
    case 'not-connected':
      return 'No bank is connected.';
    case 'needs-token':
      return 'monobank no longer accepts the token. Paste a new one in Settings.';
    case 'bank-down':
      return 'monobank is not answering. Trying again in a minute.';
    case 'up-to-date':
      return 'Up to date.';
    case 'loading':
      return left > 0
        ? `Reading history: ${state.windowsDone} of ${state.windowsTotal}.`
        : 'Reading balances.';
    case 'waiting': {
      if (left === 0) return 'Up to date.';
      const pace = state.demo
        ? ''
        : ` monobank allows one read a minute: about ${minutes} min left while the app is open.`;
      return `History: ${state.windowsDone} of ${state.windowsTotal} read.${pace}`;
    }
  }
}

export function Home(props: { go: (tab: 'settings') => void }) {
  const app = useApp();
  const data = useStored(async ({ store }) =>
    buildOverview(await store.accounts(), await store.rates()),
  );
  const state = app.syncState;

  if (state.status === 'not-connected') {
    return (
      <Screen title="Your money">
        <Card>
          <Heading>Nothing connected yet</Heading>
          <Body muted>
            Connect monobank with a token you issue yourself, or look around with made-up data. Pay
            and the ФОП report work without a bank.
          </Body>
          <Button label="Connect in Settings" onPress={() => props.go('settings')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title="Your money"
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void app.sync.refresh()} />
      }
    >
      {state.demo ? (
        <Card tone="warn">
          <Body>Demo: made-up accounts and transactions. No bank is contacted.</Body>
        </Card>
      ) : null}
      <Card>
        <Body muted>In hryvnias</Body>
        <Amount minor={data?.totalUahMinor ?? 0} currency="UAH" size={34} />
        {data?.converted ? (
          <Body muted>Foreign currency is valued at monobank’s rate of today.</Body>
        ) : null}
        {data && data.unvalued > 0 ? (
          <Body muted>
            {data.unvalued === 1 ? 'One account is' : `${data.unvalued} accounts are`} left out:
            monobank publishes no rate for the currency.
          </Body>
        ) : null}
      </Card>
      <Card>
        <Body muted>{syncText(state)}</Body>
        <Body muted>Pull down to read balances and the last days again.</Body>
      </Card>
      {(data?.accounts ?? []).map((account) => (
        <Card key={account.id}>
          <Row>
            <View style={{ flex: 1 }}>
              <Heading>{account.name}</Heading>
              <Body muted>
                {account.kind === 'jar' ? 'Jar' : account.last4 ? `•• ${account.last4}` : 'Card'}
              </Body>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Amount minor={account.ownMinor} currency={account.currency} size={18} />
              {account.currency !== 'UAH' && account.uahMinor !== null ? (
                <Amount minor={account.uahMinor} currency="UAH" size={13} muted />
              ) : null}
            </View>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
