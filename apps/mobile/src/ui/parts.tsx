import { NBSP, moneyParts } from '@ledger-lens/contracts';
import type { ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type RefreshControlProps,
  type TextStyle,
} from 'react-native';
import { useTheme } from './theme';

export function Screen(props: {
  title: string;
  children: ReactNode;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={props.refreshControl}
    >
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 28, fontWeight: '700' }}>
        {props.title}
      </Text>
      {props.children}
    </ScrollView>
  );
}

export function Card(props: { children: ReactNode; tone?: 'plain' | 'warn' }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: props.tone === 'warn' ? t.warnSoft : t.surface,
        borderRadius: 16,
        padding: 16,
        gap: 8,
      }}
    >
      {props.children}
    </View>
  );
}

export function Heading(props: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>
      {props.children}
    </Text>
  );
}

export function Body(props: { children: ReactNode; muted?: boolean; style?: TextStyle }) {
  const t = useTheme();
  return (
    <Text
      style={[{ color: props.muted ? t.text2 : t.text, fontSize: 15, lineHeight: 21 }, props.style]}
    >
      {props.children}
    </Text>
  );
}

/** Ukrainian format, small kopiykas, tabular figures. Green and a plus for money in when `signed`; no red for spending. */
export function Amount(props: {
  minor: number;
  currency: string;
  size?: number;
  signed?: boolean;
  muted?: boolean;
}) {
  const t = useTheme();
  const size = props.size ?? 16;
  const parts = moneyParts(props.minor, props.currency);
  const income = props.signed === true && props.minor > 0;
  const color = income ? t.income : props.muted ? t.text2 : t.text;
  const sign = parts.negative ? '−' : income ? '+' : '';
  return (
    <Text
      style={{ color, fontSize: size, fontWeight: '600', fontVariant: ['tabular-nums'] }}
      accessibilityLabel={`${sign}${parts.whole}${parts.fraction ? `,${parts.fraction}` : ''} ${parts.symbol}`}
    >
      {sign}
      {parts.whole}
      {parts.fraction ? (
        <Text style={{ fontSize: size * 0.7, color }}>,{parts.fraction}</Text>
      ) : null}
      {NBSP}
      {parts.symbol}
    </Text>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'soft' | 'danger';
  disabled?: boolean;
}) {
  const t = useTheme();
  const kind = props.kind ?? 'primary';
  const background = kind === 'primary' ? t.accent : t.surface2;
  const color = kind === 'primary' ? t.onAccent : kind === 'danger' ? t.danger : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        backgroundColor: background,
        opacity: props.disabled ? 0.45 : pressed ? 0.8 : 1,
        borderRadius: 12,
        minHeight: 48,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
      })}
    >
      <Text style={{ color, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  problem?: string | null;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
  maxLength?: number;
  secure?: boolean;
  autoCapitalize?: 'none' | 'characters' | 'sentences';
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.text2, fontSize: 13 }}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={t.text2}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
        maxLength={props.maxLength}
        secureTextEntry={props.secure}
        autoCapitalize={props.autoCapitalize ?? 'none'}
        autoCorrect={false}
        style={{
          color: t.text,
          backgroundColor: t.surface2,
          borderColor: props.problem ? t.danger : t.line,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 16,
          minHeight: props.multiline ? 96 : 44,
          textAlignVertical: 'top',
        }}
      />
      {props.problem ? (
        <Text accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: 13 }}>
          {props.problem}
        </Text>
      ) : null}
    </View>
  );
}

/** A choice between a few options; the chosen one is marked by fill and by its selected state, never colour alone. */
export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={props.label}
      style={{ flexDirection: 'row', backgroundColor: t.surface2, borderRadius: 10, padding: 2 }}
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(option.value)}
            style={{
              flex: 1,
              minHeight: 40,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? t.surface : 'transparent',
            }}
          >
            <Text style={{ color: t.text, fontSize: 14, fontWeight: selected ? '700' : '400' }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row(props: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {props.children}
    </View>
  );
}
