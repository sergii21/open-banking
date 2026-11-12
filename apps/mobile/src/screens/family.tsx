import { qrCode, qrPath } from '@web-shared/qr';
import {
  buildFamilyView,
  minorToDecimalString,
  parseAmountToMinor,
  type Category,
  type FamilyView,
} from '@ledger-lens/contracts';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';
import { useApp, useStored } from '../app-state';
import { DEFAULT_RELAY_URL } from '../family/config';
import { parseInvite } from '../family/crypto';
import { familyProblemText, type FamilyState } from '../family/service';
import { summaryMonths } from '../family/summary';
import { Amount, Body, Button, Card, Field, Heading, Row, Screen, Segmented } from '../ui/parts';
import { QrCodeView } from '../ui/qr';
import { useTheme } from '../ui/theme';

const CATEGORY_NAMES: Record<Category, string> = {
  groceries: 'Groceries',
  dining: 'Eating out',
  transport: 'Transport',
  shopping: 'Shopping',
  bills: 'Bills',
  subscriptions: 'Subscriptions',
  health: 'Health',
  entertainment: 'Entertainment',
  travel: 'Travel',
  transfers: 'Transfers',
  income: 'Income',
  other: 'Other',
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const monthName = (month: string): string =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** A share of the whole as a bar. The figure beside it says the same in numbers: the bar is never the only carrier. */
function Bar(props: { share: number; over?: boolean }) {
  const t = useTheme();
  const width = Math.max(0, Math.min(1, props.share)) * 100;
  return (
    <View
      accessible={false}
      style={{ height: 8, borderRadius: 4, backgroundColor: t.surface2, overflow: 'hidden' }}
    >
      <View
        style={{
          width: `${width}%`,
          height: 8,
          borderRadius: 4,
          backgroundColor: props.over ? t.warn : t.accent,
        }}
      />
    </View>
  );
}

function Welcome(props: {
  invite: string | null;
  run: (task: () => Promise<void>) => Promise<boolean>;
  busy: boolean;
  problem: string | null;
}) {
  const app = useApp();
  const [name, setName] = useState('');
  const [relay, setRelay] = useState(DEFAULT_RELAY_URL);
  const [invitation, setInvitation] = useState(props.invite ?? '');
  useEffect(() => {
    if (props.invite) setInvitation(props.invite);
  }, [props.invite]);
  const invited = parseInvite(invitation) !== null;

  return (
    <Screen title="Family">
      <Card>
        <Heading>One budget, everyone’s own bank</Heading>
        <Body muted>
          Each person connects their own bank on their own phone, with their own token. The phones
          share only the month’s totals by category, and their money if they choose to: never a
          token, a transaction or a card.
        </Body>
        <Body muted>
          The totals are encrypted on the phone with a key only your family has. The relay that
          passes them on cannot read them.
        </Body>
      </Card>
      <Card>
        <Field
          label="Your name, as the family will see it"
          value={name}
          onChangeText={setName}
          maxLength={40}
          autoCapitalize="sentences"
          problem={props.problem}
        />
      </Card>
      <Card>
        <Heading>Join with an invitation</Heading>
        <Body muted>
          Point this iPhone’s camera at the code on a family member’s phone, or paste the invitation
          they sent you.
        </Body>
        <Field
          label="Invitation"
          value={invitation}
          onChangeText={setInvitation}
          placeholder="ledgerlens://family#…"
          autoCapitalize="none"
          secure
        />
        <Button
          kind="soft"
          label="Paste"
          onPress={() => void Clipboard.getStringAsync().then(setInvitation)}
        />
        <Button
          label={props.busy ? 'Joining…' : 'Join the family'}
          disabled={props.busy || !invited || name.trim() === ''}
          onPress={() => void props.run(() => app.family.join(invitation, name))}
        />
      </Card>
      <Card>
        <Heading>Or start a new family</Heading>
        <Body muted>
          The relay is a small service you or someone you trust runs (apps/relay in the project). It
          only ever holds encrypted totals.
        </Body>
        <Field
          label="Relay address"
          value={relay}
          onChangeText={setRelay}
          placeholder="https://…"
          keyboardType="url"
          autoCapitalize="none"
        />
        <Button
          kind="soft"
          label={props.busy ? 'Starting…' : 'Start a family'}
          disabled={props.busy || name.trim() === '' || relay.trim() === ''}
          onPress={() => void props.run(() => app.family.start(name, relay))}
        />
      </Card>
    </Screen>
  );
}

function Month(props: { view: FamilyView; me: string; today: string }) {
  const { view } = props;
  const budget = view.budget;
  return (
    <>
      <Card>
        <Body muted>Spent in {monthName(view.month)}</Body>
        <Amount minor={view.spentMinor} currency="UAH" size={34} />
        {budget ? (
          <>
            <Bar share={view.spentMinor / budget.monthlyMinor} over={budget.leftMinor < 0} />
            <Row>
              <Body muted>
                {budget.usedPercent}% of the budget
                {budget.leftMinor < 0 ? ': over it by' : ', left'}
              </Body>
              <Amount minor={Math.abs(budget.leftMinor)} currency="UAH" size={15} />
            </Row>
          </>
        ) : (
          <Body muted>No monthly budget is set.</Body>
        )}
        {view.incomeMinor > 0 ? (
          <Row>
            <Body muted>Money in</Body>
            <Amount minor={view.incomeMinor} currency="UAH" size={15} signed />
          </Row>
        ) : null}
      </Card>

      <Card>
        <Heading>By person</Heading>
        {view.members.map((member) => (
          <View key={member.memberId} style={{ gap: 4 }}>
            <Row>
              <Body>
                {member.name}
                {member.memberId === props.me ? ' (you)' : ''}
              </Body>
              <Amount minor={member.spentMinor} currency="UAH" size={16} />
            </Row>
            <Bar share={member.share} />
            <Body muted style={{ fontSize: 13 }}>
              {member.noMonth
                ? 'No figures for this month from this phone.'
                : `${Math.round(member.share * 100)}% of the family’s spending.`}
              {member.updatedAt < Date.parse(`${props.today}T00:00:00Z`) - 86_400_000
                ? ` Last opened ${new Date(member.updatedAt).toISOString().slice(0, 10)}.`
                : ''}
            </Body>
          </View>
        ))}
      </Card>

      {view.categories.length > 0 ? (
        <Card>
          <Heading>By category</Heading>
          {view.categories.map((line) => (
            <View key={line.category} style={{ gap: 4 }}>
              <Row>
                <Body>{CATEGORY_NAMES[line.category]}</Body>
                <Amount minor={line.spentMinor} currency="UAH" size={16} />
              </Row>
              <Bar share={line.share} />
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Heading>The family’s money</Heading>
        {view.balancesShared > 0 ? (
          <Amount minor={view.balanceMinor} currency="UAH" size={24} />
        ) : (
          <Body muted>Nobody shares their money yet.</Body>
        )}
        {view.members
          .filter((member) => member.balanceMinor !== null)
          .map((member) => (
            <Row key={member.memberId}>
              <Body muted>{member.name}</Body>
              <Amount minor={member.balanceMinor ?? 0} currency="UAH" size={15} muted />
            </Row>
          ))}
        {view.balancesShared > 0 && view.balancesHidden > 0 ? (
          <Body muted>
            Without {view.balancesHidden === 1 ? 'one person' : `${view.balancesHidden} people`} who
            do not share theirs.
          </Body>
        ) : null}
      </Card>
    </>
  );
}

function Joined(props: {
  state: FamilyState;
  run: (task: () => Promise<void>) => Promise<boolean>;
  busy: boolean;
  problem: string | null;
}) {
  const app = useApp();
  const { state } = props;
  const today = app.calendar.dayKey(app.clock.now().getTime());
  const [thisMonth, lastMonth] = summaryMonths(today);
  const [month, setMonth] = useState(thisMonth);
  const [budgetText, setBudgetText] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const view = useMemo(() => buildFamilyView(state.summaries, month), [state.summaries, month]);
  const invitation = useStored(({ family }) => family.invitation(), showInvite);
  const code = showInvite && invitation ? qrCode(invitation) : null;

  // Opening the tab leaves this phone's figures on the relay and reads the family's.
  const refresh = props.run;
  useEffect(() => {
    void refresh(() => app.family.refresh());
    // Once per visit: `app` changes with every stored change, and a refresh is one.
  }, []);

  const typedBudget = budgetText.trim() === '' ? null : parseAmountToMinor(budgetText, 'UAH');
  const confirmLeave = (): void => {
    Alert.alert(
      'Leave the family?',
      'Your totals are removed from the relay and the family from this phone. Your bank connection and history stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () =>
            void props
              .run(() => app.family.leave())
              .then((left) => {
                if (left) return;
                Alert.alert(
                  'The relay did not answer',
                  'Forget the family on this phone anyway? What the relay keeps of you expires in 90 days.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Forget',
                      style: 'destructive',
                      onPress: () => void props.run(() => app.family.forget()),
                    },
                  ],
                );
              }),
        },
      ],
    );
  };

  return (
    <Screen
      title="Family"
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => void props.run(() => app.family.refresh())}
        />
      }
    >
      {props.problem ? (
        <Card tone="warn">
          <Body>{props.problem}</Body>
        </Card>
      ) : null}
      {!state.live ? (
        <Card tone="warn">
          <Body>
            This phone shares no figures: {''}
            {app.syncState.demo
              ? 'the demo’s made-up data stays here.'
              : 'no bank is connected on it.'}{' '}
            You still see the family’s.
          </Body>
        </Card>
      ) : null}
      <Segmented
        label="Month"
        value={month}
        onChange={setMonth}
        options={[
          { value: thisMonth, label: 'This month' },
          { value: lastMonth, label: 'Last month' },
        ]}
      />
      <Month view={view} me={state.memberId} today={today} />
      <Card>
        <Body muted>
          {state.syncedAt
            ? `Read from the relay at ${new Date(state.syncedAt).toISOString().slice(11, 16)} UTC. Pull down to read again.`
            : 'Not read from the relay yet. Pull down to read.'}
          {' Each person’s figures are as fresh as the last time they opened the app.'}
        </Body>
        {state.unreadable > 0 ? (
          <Body muted>
            {state.unreadable === 1 ? 'One entry' : `${state.unreadable} entries`} on the relay
            could not be read by this version of the app and {state.unreadable === 1 ? 'is' : 'are'}{' '}
            left out.
          </Body>
        ) : null}
      </Card>

      <Card>
        <Heading>Monthly budget</Heading>
        <Body muted>
          For the whole family, in hryvnias. Anyone can change it
          {view.budget ? `; ${view.budget.setBy} set the current one` : ''}.
        </Body>
        <Field
          label="Budget for a month, ₴"
          value={budgetText}
          onChangeText={setBudgetText}
          keyboardType="decimal-pad"
          placeholder={
            view.budget ? minorToDecimalString(view.budget.monthlyMinor, 'UAH') : '40000'
          }
          problem={budgetText.trim() !== '' && typedBudget === null ? 'Type an amount.' : null}
        />
        <Button
          label="Set the budget"
          disabled={props.busy || typedBudget === null}
          onPress={() =>
            void props
              .run(() => app.family.setBudget(typedBudget ?? 0))
              .then((done) => (done ? setBudgetText('') : undefined))
          }
        />
        {view.budget ? (
          <Button
            kind="soft"
            label="Remove the budget"
            disabled={props.busy}
            onPress={() => void props.run(() => app.family.setBudget(0))}
          />
        ) : null}
      </Card>

      <Card>
        <Heading>What you share</Heading>
        <Body muted>
          Always: what you spent this month and last, by category. Never: transactions, shops, cards
          or your token.
        </Body>
        <Segmented
          label="What you share"
          value={state.shareBalance ? 'balance' : 'spending'}
          onChange={(value) =>
            void props.run(() => app.family.setShareBalance(value === 'balance'))
          }
          options={[
            { value: 'spending', label: 'Spending only' },
            { value: 'balance', label: 'And my money' },
          ]}
        />
      </Card>

      <Card>
        <Heading>Invite someone</Heading>
        <Body muted>
          They open Ledger Lens on their own phone and point the camera at this code. The code is
          the family’s key: show it only to the people you are inviting.
        </Body>
        {code ? (
          <QrCodeView
            size={code.size}
            path={qrPath(code)}
            label="The family invitation as a QR code"
          />
        ) : null}
        <Button
          kind="soft"
          label={showInvite ? 'Hide the code' : 'Show the invitation code'}
          onPress={() => setShowInvite(!showInvite)}
        />
        {showInvite && invitation ? (
          <Button
            kind="soft"
            label="Copy the invitation instead"
            onPress={() => void Clipboard.setStringAsync(invitation)}
          />
        ) : null}
      </Card>

      <Card>
        <Body muted>
          You are {state.name}. Relay: {state.relayUrl.replace(/^https:\/\//, '')}
        </Body>
        <Button
          kind="danger"
          label="Leave the family"
          disabled={props.busy}
          onPress={confirmLeave}
        />
      </Card>
    </Screen>
  );
}

export function Family(props: { invite: string | null }) {
  const app = useApp();
  const state = useStored(({ family }) => family.state());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** True when the task went through. */
  const run = async (task: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      await task();
      return true;
    } catch (error) {
      setProblem(familyProblemText(error));
      return false;
    } finally {
      setBusy(false);
      app.touch();
    }
  };

  if (!state) return <Screen title="Family">{null}</Screen>;
  return state.joined ? (
    <Joined state={state} run={run} busy={busy} problem={problem} />
  ) : (
    <Welcome invite={props.invite} run={run} busy={busy} problem={problem} />
  );
}
