import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { FileDetailsScreen } from '../features/files/FileDetailsScreen';
import { FilesScreen } from '../features/files/FilesScreen';
import { TransfersScreen } from '../features/files/TransfersScreen';
import { SharedLinksScreen } from '../features/sharing/SharedLinksScreen';
import { useI18n } from '../i18n/I18nProvider';

export type FilesStackParamList = {
  FilesList: undefined;
  FileDetails: { fileId: string };
  Transfers: undefined;
  SharedLinks: undefined;
};

const Stack = createNativeStackNavigator<FilesStackParamList>();

export function FilesStack() {
  const { t } = useI18n();
  return (
    <Stack.Navigator>
      <Stack.Screen name="FilesList" component={FilesScreen} options={{ headerShown: false }} />
      <Stack.Screen name="FileDetails" component={FileDetailsScreen} options={{ title: t('fileDetails') }} />
      <Stack.Screen name="Transfers" component={TransfersScreen} options={{ title: t('transfers') }} />
      <Stack.Screen name="SharedLinks" component={SharedLinksScreen} options={{ title: t('sharedLinks') }} />
    </Stack.Navigator>
  );
}
