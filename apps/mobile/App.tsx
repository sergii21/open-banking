import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppProvider } from './src/app-state';
import { Activity } from './src/screens/activity';
import { Fop } from './src/screens/fop';
import { Home } from './src/screens/home';
import { Pay } from './src/screens/pay';
import { Settings } from './src/screens/settings';
import { useTheme } from './src/ui/theme';

const TABS = [
  { id: 'home', label: 'Money' },
  { id: 'activity', label: 'Transactions' },
  { id: 'pay', label: 'Pay' },
  { id: 'fop', label: 'ФОП' },
  { id: 'settings', label: 'Settings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function Shell() {
  const t = useTheme();
  const [tab, setTab] = useState<TabId>('home');
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <StatusBar style="auto" />
      <View style={{ flex: 1 }}>
        {tab === 'home' ? <Home go={setTab} /> : null}
        {tab === 'activity' ? <Activity /> : null}
        {tab === 'pay' ? <Pay /> : null}
        {tab === 'fop' ? <Fop /> : null}
        {tab === 'settings' ? <Settings /> : null}
      </View>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          backgroundColor: t.surface,
          borderTopColor: t.line,
          borderTopWidth: 0.5,
        }}
      >
        {TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(item.id)}
              style={{ flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  color: selected ? t.accent : t.text2,
                  fontSize: 12,
                  fontWeight: selected ? '700' : '500',
                  // Selected is marked by weight and an underline, not by colour alone.
                  textDecorationLine: selected ? 'underline' : 'none',
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function Loading() {
  const t = useTheme();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}
    >
      <ActivityIndicator accessibilityLabel="Opening Ledger Lens" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider fallback={<Loading />}>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
