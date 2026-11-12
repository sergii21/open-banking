import { AppError } from '@api/errors';
import { useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useApp } from '../app-state';
import { Body, Button, Card, Field, Heading, Screen } from '../ui/parts';
import { syncText } from './home';

/** What went wrong, in the adapter's own words for the person. They never hold the token. */
function problemText(error: unknown): string {
  if (error instanceof AppError) return error.errors?.[0]?.message ?? error.message;
  return 'That did not work. Try again.';
}

export function Settings() {
  const app = useApp();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const state = app.syncState;
  const connected = state.status !== 'not-connected';

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await task();
      setToken('');
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmDisconnect = (): void => {
    Alert.alert(
      state.demo ? 'Leave the demo?' : 'Disconnect monobank?',
      state.demo
        ? 'The made-up data is removed from this phone.'
        : 'The token and the monobank history are removed from this phone. The token stays valid at monobank until you issue a new one there.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void run(() => app.disconnect()) },
      ],
    );
  };

  return (
    <Screen title="Settings">
      <Card>
        <Heading>{state.demo ? 'Demo' : 'monobank'}</Heading>
        <Body muted>{syncText(state)}</Body>
        {connected ? (
          <Button
            kind="danger"
            label={state.demo ? 'Leave the demo' : 'Disconnect and remove data'}
            onPress={confirmDisconnect}
            disabled={busy}
          />
        ) : null}
      </Card>

      {!connected || state.status === 'needs-token' || state.demo ? (
        <Card>
          <Heading>Connect monobank</Heading>
          <Body muted>
            Issue a personal token at api.monobank.ua and paste it here. It can only read. It is
            kept in this iPhone’s Keychain and sent only to monobank.
          </Body>
          <Button
            kind="soft"
            label="Open api.monobank.ua"
            onPress={() => void Linking.openURL('https://api.monobank.ua/')}
          />
          <Field
            label="Token"
            value={token}
            onChangeText={setToken}
            secure
            problem={problem}
            placeholder="Paste the token"
          />
          <Button
            label={busy ? 'Checking…' : 'Connect'}
            disabled={busy || token.trim() === ''}
            onPress={() => void run(() => app.connect(token))}
          />
          {!connected ? (
            <Button
              kind="soft"
              label="Try with made-up data"
              disabled={busy}
              onPress={() => void run(() => app.startDemo())}
            />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Heading>What this app does and does not do</Heading>
        <Body muted>
          It reads your own accounts and never moves money: a payment is always confirmed in your
          bank’s app. There is no server. The token is in the Keychain; the transaction history and
          the ФОП rows are plain data in this app’s own folder on the phone, not encrypted by the
          app.
        </Body>
        <Body muted>
          If the same token is also used on your computer, the two share monobank’s limit of one
          read a minute, so history may load more slowly on both.
        </Body>
      </Card>
    </Screen>
  );
}
