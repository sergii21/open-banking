import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppProvider } from './src/app-state';
import { parseInvite } from './src/family/crypto';
import { Activity } from './src/screens/activity';
import { Family } from './src/screens/family';
import { Fop } from './src/screens/fop';
import { Home } from './src/screens/home';
import { Pay } from './src/screens/pay';
import { Settings } from './src/screens/settings';
import { Icon, type IconName } from './src/ui/icons';
import { useTheme } from './src/ui/theme';

const TABS = [
  { id: 'home', label: 'Money', icon: 'wallet' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'pay', label: 'Pay', icon: 'scan' },
  { id: 'family', label: 'Family', icon: 'people' },
  { id: 'fop', label: 'ФОП', icon: 'report' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
type TabId = (typeof TABS)[number]['id'];

function Shell() {
  const t = useTheme();
  const [tab, setTab] = useState<TabId>('home');
  const [invite, setInvite] = useState<string | null>(null);

  // A family invitation opened from the camera or a message: the link is kept for the Family tab and goes nowhere else.
  useEffect(() => {
    const open = (url: string | null | undefined): void => {
      if (!url || !parseInvite(url)) return;
      setInvite(url);
      setTab('family');
    };
    void Linking.getInitialURL().then(open);
    const listener = Linking.addEventListener('url', (event) => open(event.url));
    return () => listener.remove();
  }, []);
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
        {tab === 'family' ? <Family invite={invite} /> : null}
        {tab === 'fop' ? <Fop /> : null}
        {tab === 'settings' ? <Settings /> : null}
      </View>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          paddingTop: 6,
          paddingHorizontal: 2,
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
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => setTab(item.id)}
              hitSlop={4}
              style={{
                flex: 1,
                minHeight: 56,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
              }}
            >
              {/* Selected is a filled pill behind a heavier icon and a bolder label: shape and weight, not colour alone. */}
              <View
                style={{
                  width: 50,
                  height: 30,
                  borderRadius: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: selected ? t.accentSoft : 'transparent',
                }}
              >
                <Icon name={item.icon} color={selected ? t.accent : t.text2} bold={selected} />
              </View>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  color: selected ? t.accent : t.text2,
                  fontSize: 11,
                  fontWeight: selected ? '700' : '500',
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
