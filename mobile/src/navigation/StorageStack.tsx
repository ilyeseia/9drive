import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AddAccountScreen } from '../features/storage/AddAccountScreen';
import { ConnectProviderScreen } from '../features/storage/ConnectProviderScreen';
import { RoutingScreen } from '../features/storage/RoutingScreen';
import { StorageScreen } from '../features/storage/StorageScreen';
import { useI18n } from '../i18n/I18nProvider';

export type StorageStackParamList = {
  StorageList: undefined;
  Routing: undefined;
  AddAccount: undefined;
  ConnectS3: undefined;
};

const Stack = createNativeStackNavigator<StorageStackParamList>();

export function StorageStack() {
  const { t } = useI18n();
  return (
    <Stack.Navigator>
      <Stack.Screen name="StorageList" component={StorageScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Routing" component={RoutingScreen} options={{ title: t('routing') }} />
      <Stack.Screen name="AddAccount" component={ConnectProviderScreen} options={{ title: t('addAccount') }} />
      <Stack.Screen name="ConnectS3" component={AddAccountScreen} options={{ title: t('connectS3') }} />
    </Stack.Navigator>
  );
}
