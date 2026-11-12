import { PAYMENT_LIMITS } from '@ledger-lens/contracts';
import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';
import { Linking, Share } from 'react-native';
import { EMPTY_PAY_FORM, payView, readPayText, type PayForm } from '../model/pay';
import { Body, Button, Card, Field, Heading, Screen, Segmented } from '../ui/parts';
import { QrCodeView } from '../ui/qr';

/**
 * Pay from pasted text: an invoice or a message goes in, the details come out as the National Bank of Ukraine's
 * payment link and code. The person opens the link in their own bank's app and confirms there. Nothing is sent
 * anywhere and nothing is kept: leaving the screen forgets the text. The app moves no money.
 */
export function Pay() {
  const [text, setText] = useState('');
  const [form, setForm] = useState<PayForm>(EMPTY_PAY_FORM);
  const [note, setNote] = useState<string | null>(null);
  const view = useMemo(() => payView(form), [form]);
  const set = (patch: Partial<PayForm>): void => setForm((old) => ({ ...old, ...patch }));

  const read = (next: string): void => {
    setText(next);
    setForm(readPayText(next));
    setNote(null);
  };
  const paste = async (): Promise<void> => {
    const clip = await Clipboard.getStringAsync();
    if (clip.trim() === '') setNote('The clipboard has no text in it.');
    else read(clip);
  };
  const copy = async (value: string, what: string): Promise<void> => {
    await Clipboard.setStringAsync(value);
    setNote(`${what} copied.`);
  };
  const open = async (url: string): Promise<void> => {
    try {
      await Linking.openURL(url);
    } catch {
      setNote('The link could not be opened on this phone. Copy it instead.');
    }
  };

  return (
    <Screen title="Pay">
      <Card>
        <Body muted>
          Paste an invoice or a message with payment details. You confirm the payment in your bank’s
          app: Ledger Lens sends nothing.
        </Body>
        <Button label="Paste from the clipboard" onPress={() => void paste()} />
        <Field
          label="Or type or paste the text here"
          value={text}
          onChangeText={read}
          multiline
          autoCapitalize="sentences"
        />
        {text !== '' ? <Button kind="soft" label="Clear" onPress={() => read('')} /> : null}
        {note ? <Body>{note}</Body> : null}
      </Card>

      <Segmented
        label="Pay to"
        value={form.kind}
        onChange={(kind) => set({ kind })}
        options={[
          { value: 'account', label: 'To an account' },
          { value: 'card', label: 'To a card' },
        ]}
      />

      {form.kind === 'card' ? (
        <Card>
          <Field
            label="Card number"
            value={view.cardText}
            onChangeText={(typed) => set({ card: typed.replace(/\D/g, '').slice(0, 16) })}
            keyboardType="number-pad"
            problem={view.cardProblem}
          />
          <Field
            label="Amount, ₴"
            value={form.amount}
            onChangeText={(amount) => set({ amount })}
            keyboardType="decimal-pad"
            placeholder="Optional"
            problem={view.amountProblem}
          />
          <Button
            label="Copy the card number"
            disabled={view.cardProblem !== null || form.card === ''}
            onPress={() => void copy(form.card, 'Card number')}
          />
          <Button
            kind="soft"
            label="Copy the amount"
            disabled={form.amount.trim() === '' || view.amountProblem !== null}
            onPress={() => void copy(form.amount.trim(), 'Amount')}
          />
          {view.privatLink ? (
            <>
              <Button
                kind="soft"
                label="Open in Privat24"
                onPress={() => void open(view.privatLink ?? '')}
              />
              <Body muted>
                Opens Privat24’s transfer form with the card and the amount filled in. PrivatBank
                does not document this link and it has not been tried yet: check both before you
                confirm.
              </Body>
            </>
          ) : null}
          <Body muted>
            There is no payment code for a card. Open your bank’s app, choose a transfer to a card,
            paste the number and the amount, and compare both with the message before you confirm.
          </Body>
        </Card>
      ) : (
        <Card>
          <Field
            label="Recipient"
            value={form.recipient}
            onChangeText={(recipient) => set({ recipient })}
            maxLength={PAYMENT_LIMITS.recipient}
            autoCapitalize="sentences"
            problem={view.problems.recipient}
          />
          <Field
            label="Account (IBAN)"
            value={form.iban}
            onChangeText={(typed) => set({ iban: typed.replace(/\s/g, '').toUpperCase() })}
            autoCapitalize="characters"
            problem={view.problems.iban}
          />
          <Field
            label="Recipient’s code (8 or 10 digits)"
            value={form.code}
            onChangeText={(code) => set({ code })}
            keyboardType="number-pad"
            problem={view.problems.code}
          />
          <Field
            label="Amount, ₴"
            value={form.amount}
            onChangeText={(amount) => set({ amount })}
            keyboardType="decimal-pad"
            placeholder="Optional"
            problem={view.amountProblem ?? view.problems.amount}
          />
          <Field
            label="Purpose"
            value={form.purpose}
            onChangeText={(purpose) => set({ purpose })}
            maxLength={PAYMENT_LIMITS.purpose}
            multiline
            autoCapitalize="sentences"
            problem={view.problems.purpose}
          />
          {view.tooLong ? (
            <Body>The details are too long for a payment code. Shorten the purpose.</Body>
          ) : null}
        </Card>
      )}

      {form.kind === 'account' && view.link ? (
        <Card>
          <Heading>Ready</Heading>
          <Body muted>
            Open the link and choose your bank’s app. Check the recipient, the account and the
            amount there before you confirm.
          </Body>
          <Button label="Open in a bank app" onPress={() => void open(view.link ?? '')} />
          <Button
            kind="soft"
            label="Share the link"
            onPress={() => void Share.share({ message: view.link ?? '' })}
          />
          <Button
            kind="soft"
            label="Copy the link"
            onPress={() => void copy(view.link ?? '', 'Payment link')}
          />
          {view.qr ? (
            <>
              <Body muted>Or scan this code with a bank app on another phone.</Body>
              <QrCodeView
                size={view.qr.size}
                path={view.qr.path}
                badgeRadius={view.qr.badgeRadius}
                label={view.summary}
              />
            </>
          ) : null}
        </Card>
      ) : null}
    </Screen>
  );
}
